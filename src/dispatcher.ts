import { join } from 'node:path';
import { type Server } from 'node:http';
import pkg from '../package.json' with { type: 'json' };
import { Line } from './lines.js';
import {
  startIpcServer,
  stopIpcServer,
  type IpcRequest,
  type IpcResponse,
} from './ipc.js';
import {
  mintId,
  noteUserFromLine,
  selfLine,
  userSelf,
  type HistoryEntry,
} from './history.js';
import { errMsg, log } from './log.js';
import { acquireLock, loadMetroEnv, STATE_DIR } from './paths.js';
import { loadTunnelConfig, Tunnel, webhookPort } from './tunnel.js';
import { TrainSupervisor, TRAINS_DIR } from './trains/supervisor.js';
import {
  makeEmit,
  startWebhookServer,
  trainEventToHistoryEntry,
} from './dispatcher/server.js';
import { OutboxDriver } from './outbox-driver.js';
import { createMetroMcp } from './mcp/index.js';

loadMetroEnv();
acquireLock(join(STATE_DIR, '.tail-lock'));

const self = userSelf();
log.info({ self, line: selfLine() }, 'user identity');
const seedSelf = (): void => {
  const l = selfLine();
  if (l) noteUserFromLine(l);
};
seedSelf();

process.stdout.on('error', (err) => {
  if ((err as NodeJS.ErrnoException).code !== 'EPIPE')
    log.warn({ err: errMsg(err) }, 'stdout error');
});

const supervisor = new TrainSupervisor();
const outbox = new OutboxDriver((train, action, args) =>
  supervisor.call(train, action, args),
);
const emit = makeEmit();

supervisor.onTrainEvent((env, train) => {
  const entry = trainEventToHistoryEntry(env, train);
  if (entry) emit(entry);
});

let webhookServer: Server | null = null;
const tunnelCfg = loadTunnelConfig();
const tunnel = tunnelCfg ? new Tunnel(tunnelCfg, webhookPort()) : null;

const ipc = startIpcServer(async (req: IpcRequest): Promise<IpcResponse> => {
  if (req.op === 'notify') {
    const line = req.line as HistoryEntry['line'];
    emit({
      id: mintId(),
      ts: new Date().toISOString(),
      station: Line.station(line) ?? '?',
      line,
      from: (req.from ?? userSelf()) as HistoryEntry['from'],
      to: line,
      text: req.text,
    });
    return { ok: true };
  }
  if (req.op === 'forward-call') {
    try {
      const r = await outbox.forward(
        req.train,
        req.action,
        req.args,
        req.idempotencyKey,
      );
      return { ok: true, response: r };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }
  if (req.op === 'trains-list') {
    return { ok: true, trains: supervisor.list() };
  }
  if (req.op === 'train-restart') {
    try {
      await supervisor.restart(req.name);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }
  if (req.op === 'version') {
    return { ok: true, version: pkg.version };
  }
  if (req.op === 'outbox-list') {
    return {
      ok: true,
      entries: outbox.list({ state: req.state, limit: req.limit }),
    };
  }
  if (req.op === 'outbox-retry') {
    return outbox.retry(req.outboxId)
      ? { ok: true }
      : { ok: false, error: `no outbox entry with id '${req.outboxId}'` };
  }
  return {
    ok: false,
    error: `unknown op: ${(req as { op?: string }).op ?? '(none)'}`,
  };
});

async function main(): Promise<void> {
  supervisor.start();
  const metroMcp = await createMetroMcp();
  webhookServer = await startWebhookServer(emit, metroMcp.httpHandler);
  metroMcp.startInbound();
  tunnel?.start();
  outbox.recover();
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
  outbox.stop();
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
