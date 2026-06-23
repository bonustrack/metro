import { join } from 'node:path';
import { type Server } from 'node:http';
import pkg from '../../package.json' with { type: 'json' };
import { Line } from '../stations/lines.js';
import {
  startIpcServer,
  stopIpcServer,
  type IpcRequest,
  type IpcResponse,
} from './ipc.js';
import {
  mintId,
  selfLine,
  userSelf,
  type MetroEvent,
} from './events.js';
import { errMsg, log } from './log.js';
import { acquireLock, loadMetroEnv, STATE_DIR } from './paths.js';
import { loadTunnelConfig, Tunnel, webhookPort } from './tunnel.js';
import { TrainSupervisor, TRAINS_DIR } from './supervisor.js';
import {
  makeEmit,
  startWebhookServer,
  trainEventToMetroEvent,
} from './http.js';
import { createMetroMcp } from '../mcp/index.js';

loadMetroEnv();
acquireLock(join(STATE_DIR, '.tail-lock'));

const self = userSelf();
log.info({ self, line: selfLine() }, 'user identity');

process.stdout.on('error', (err) => {
  if ((err as NodeJS.ErrnoException).code !== 'EPIPE')
    log.warn({ err: errMsg(err) }, 'stdout error');
});

const supervisor = new TrainSupervisor();
const emit = makeEmit();

supervisor.onTrainEvent((env, train) => {
  const entry = trainEventToMetroEvent(env, train);
  if (entry) emit(entry);
});

let webhookServer: Server | null = null;
const tunnelCfg = loadTunnelConfig();
const tunnel = tunnelCfg ? new Tunnel(tunnelCfg, webhookPort()) : null;

function ipcNotify(req: Extract<IpcRequest, { op: 'notify' }>): IpcResponse {
  const line = req.line as MetroEvent['line'];
  emit({
    id: mintId(),
    ts: new Date().toISOString(),
    station: Line.station(line) ?? '?',
    line,
    from: (req.from ?? userSelf()) as MetroEvent['from'],
    to: line,
    text: req.text,
  });
  return { ok: true };
}

async function ipcForwardCall(
  req: Extract<IpcRequest, { op: 'forward-call' }>,
): Promise<IpcResponse> {
  try {
    const r = await supervisor.call(req.train, req.action, req.args);
    return { ok: true, response: r };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}

async function ipcTrainRestart(
  req: Extract<IpcRequest, { op: 'train-restart' }>,
): Promise<IpcResponse> {
  try {
    await supervisor.restart(req.name);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}

async function handleIpc(req: IpcRequest): Promise<IpcResponse> {
  switch (req.op) {
    case 'notify':
      return ipcNotify(req);
    case 'forward-call':
      return ipcForwardCall(req);
    case 'trains-list':
      return { ok: true, trains: supervisor.list() };
    case 'train-restart':
      return ipcTrainRestart(req);
    case 'version':
      return { ok: true, version: pkg.version };
    default:
      return {
        ok: false,
        error: `unknown op: ${(req as { op?: string }).op ?? '(none)'}`,
      };
  }
}

const ipc = startIpcServer(handleIpc);

async function main(): Promise<void> {
  supervisor.start();
  const metroMcp = await createMetroMcp();
  webhookServer = await startWebhookServer(emit, metroMcp.httpHandler);
  metroMcp.startInbound();
  tunnel?.start();
  log.info(
    { tunnel: !!tunnel, trainsDir: TRAINS_DIR, mcp: '/' },
    'dispatcher ready',
  );
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('dispatcher shutting down');
  tunnel?.stop();
  await stopIpcServer(ipc).catch(() => undefined);
  if (webhookServer) {
    const server = webhookServer;
    await new Promise<void>((r) =>
      server.close(() => {
        r();
      }),
    );
  }
  await supervisor.stop();
  process.exit(0);
}
const onShutdown = (): void => {
  void shutdown();
};
if (process.env.METRO_STDIN_SHUTDOWN === '1')
  process.stdin.on('end', onShutdown).on('close', onShutdown);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, onShutdown);

await main();
