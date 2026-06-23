import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { errMsg, log } from './log.js';
import { STATE_DIR } from './paths.js';
import type { TrainCallResponse } from './protocol.js';
import type { TrainInfo } from './supervisor.js';

const SOCKET_PATH = join(STATE_DIR, 'metro.sock');

export type IpcRequest =
  | { op: 'notify'; line: string; from?: string; text: string }
  | {
      op: 'forward-call';
      train: string;
      action: string;
      args: unknown;
    }
  | { op: 'trains-list' }
  | { op: 'train-restart'; name: string }
  | { op: 'version' };

export type IpcResponse =
  | { ok: true }
  | { ok: true; response: TrainCallResponse }
  | { ok: true; trains: TrainInfo[] }
  | { ok: true; version: string }
  | { ok: false; error: string };

type Handler = (req: IpcRequest) => Promise<IpcResponse> | IpcResponse;

export function startIpcServer(handler: Handler): Server {
  if (existsSync(SOCKET_PATH)) {
    try {
      unlinkSync(SOCKET_PATH);
    } catch {
    }
  }
  const server = createServer({ allowHalfOpen: true }, (s) => {
    handleConnection(s, handler);
  });
  server.on('error', (err) => {
    log.warn({ err: errMsg(err) }, 'ipc server error');
  });
  server.listen(SOCKET_PATH, () => {
    log.debug({ path: SOCKET_PATH }, 'ipc socket listening');
  });
  return server;
}

export async function stopIpcServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  try {
    if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
  } catch {
  }
}

function handleConnection(socket: Socket, handler: Handler): void {
  let buf = '';
  socket.setEncoding('utf8');
  const onData = async (chunk: Buffer | string): Promise<void> => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const nl = buf.indexOf('\n');
    if (nl === -1) return;
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    let resp: IpcResponse;
    try {
      const req = JSON.parse(line) as IpcRequest;
      resp = await handler(req);
    } catch (err) {
      resp = { ok: false, error: errMsg(err) };
    }
    socket.write(JSON.stringify(resp) + '\n');
    socket.end();
  };
  socket.on('data', (chunk) => {
    void onData(chunk);
  });
  socket.on('error', (err) => {
    log.debug({ err: errMsg(err) }, 'ipc connection error');
  });
}

export function ipcCall(
  req: IpcRequest,
  timeoutMs = 60_000,
): Promise<IpcResponse> {
  return new Promise((resolve, reject) => {
    if (!existsSync(SOCKET_PATH)) {
      reject(new Error('metro daemon is not running (start it with `metro`)'));
      return;
    }
    const socket = createConnection({ path: SOCKET_PATH });
    let buf = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`ipc timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.on('connect', () => {
      socket.write(JSON.stringify(req) + '\n');
    });
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      const line = buf.slice(0, nl).trim();
      socket.end();
      try {
        resolve(JSON.parse(line) as IpcResponse);
      } catch (err) {
        reject(new Error(`ipc bad response: ${errMsg(err)}`));
      }
    });
    socket.on('end', () => {
      clearTimeout(timer);
      if (!buf) reject(new Error('ipc connection closed without response'));
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
