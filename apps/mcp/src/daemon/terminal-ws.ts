import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { errMsg, log } from './log.js';
import { isRecord } from './is-record.js';
import { takeTerminalTicket } from './terminal-tickets.js';

const TICKET_PATH = /^\/api\/terminal\/([A-Za-z0-9_-]{43})$/;
const MAX_MESSAGE = 1024 * 1024;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 36;
const MAX_DIMENSION = 500;

export interface TerminalSocketDeps {
  command: string[];
  takeTicket?: (ticket: string) => string | null;
}

const rawBytes = (data: RawData): Buffer =>
  Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);

const dimension = (raw: unknown, fallback: number): number =>
  typeof raw === 'number' && Number.isInteger(raw) && raw > 1 && raw <= MAX_DIMENSION ? raw : fallback;

function runTerminal(ws: WebSocket, command: string[], subject: string): void {
  const terminal = new Bun.Terminal({
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    data: (_term, chunk) => {
      if (ws.readyState === ws.OPEN) ws.send(chunk);
    },
  });
  const proc = Bun.spawn(command, {
    terminal,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });
  log.info({ subject, pid: proc.pid, command: command[0] }, 'terminal: opened');
  ws.on('message', (data, isBinary) => {
    const bytes = rawBytes(data);
    if (isBinary) {
      terminal.write(bytes);
      return;
    }
    try {
      const control: unknown = JSON.parse(bytes.toString('utf8'));
      if (isRecord(control) && 'cols' in control)
        terminal.resize(dimension(control.cols, DEFAULT_COLS), dimension(control.rows, DEFAULT_ROWS));
    } catch (err) {
      log.warn({ err: errMsg(err) }, 'terminal: bad control frame');
    }
  });
  ws.on('close', () => {
    proc.kill();
    terminal.close();
    log.info({ subject, pid: proc.pid }, 'terminal: closed by the page');
  });
  proc.exited
    .then((code) => {
      if (ws.readyState === ws.OPEN) ws.close(1000, `exit ${String(code)}`);
      terminal.close();
    })
    .catch((err: unknown) => {
      log.warn({ err: errMsg(err) }, 'terminal: exit watch failed');
    });
}

function refuse(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${String(status)} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

export function attachTerminalSockets(server: Server, deps: TerminalSocketDeps): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  const take = deps.takeTicket ?? takeTerminalTicket;
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    const found = TICKET_PATH.exec(path);
    if (!found) {
      refuse(socket, 404, 'Not Found');
      return;
    }
    const subject = take(found[1] ?? '');
    if (subject === null) {
      refuse(socket, 401, 'Unauthorized');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      runTerminal(ws, deps.command, subject);
    });
  });
}
