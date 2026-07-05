import { join } from 'node:path';
import { type Server } from 'node:http';
import { selfLine, userSelf } from './events.js';
import { setTrainCallBackend } from './train-call.js';
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
import { metroCall } from '../mcp/ctx.js';

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

setTrainCallBackend((train, action, args) =>
  supervisor.call(train, action, args),
);

async function main(): Promise<void> {
  supervisor.start();
  const metroMcp = await createMetroMcp();
  webhookServer = await startWebhookServer(
    emit,
    metroMcp.httpHandler,
    metroCall,
  );
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
