import { spyOn } from 'bun:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleRelayRequest } from '../src/connectors/relay.js';
import { localMigrationIdle } from '../src/connectors/migration-guard.js';
import { migrationRecord, saveMigration } from '../src/connectors/migration-state.js';
import { close, listen, within } from './org-sync-control-fixture.js';
import { migrationFixture, SOURCE } from './migration-control-fixture.js';

export { SOURCE };
const ENV = ['HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'METRO_AGENTS_DIR', 'METRO_STATE_DIR', 'METRO_CLAUDE_DIR', 'METRO_RUNTIME_STORE', 'METRO_RUNTIME_DIR', 'METRO_TRAINS_DIR', 'METRO_UPLOAD_DIR', 'METRO_XMTP_ATTACH_DIR', 'GMAIL_STATE_DIR', 'OUTLOOK_STATE_DIR', 'TELEGRAM_BOT_STATE_DIR', 'THREEMA_GROUPS_DIR', 'WHATSAPP_TOKEN_DIR'] as const;

export function isolatePassiveTests(): () => void {
  const previous = ENV.map((name) => [name, process.env[name]] as const);
  const root = mkdtempSync(join(tmpdir(), 'metro-passive-home-'));
  for (const name of ENV) { const dir = join(root, name); mkdirSync(dir); process.env[name] = dir; }
  return () => {
    for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    rmSync(root, { recursive: true, force: true });
  };
}

export async function passiveFixture(oauth = false) {
  const f = migrationFixture(oauth);
  let initial = ': listener\n\n';
  let contentType = 'text/event-stream';
  let status = 200;
  let opened = Promise.withResolvers<ServerResponse>();
  const remotes: ServerResponse[] = [];
  const requests: IncomingMessage[] = [];
  const server = createServer((req, res) => {
    requests.push(req); remotes.push(res);
    res.writeHead(status, { 'content-type': contentType });
    if (initial !== '') res.write(initial);
    else res.flushHeaders();
    opened.resolve(res);
  });
  const upstream = await listen(server).catch((error: unknown) => { rmSync(f.dir, { recursive: true, force: true }); throw error; });
  const relay = createServer((req, res) => {
    handleRelayRequest(req, res, {
      migrationDir: f.dir, identify: () => ({ subject: 'fixture', agentId: 'apiagent001' }), signedOut: () => {},
      target: () => Promise.resolve({ kind: 'ok', url: upstream, headers: {} }),
    });
  });
  const base = await listen(relay).catch(async (error: unknown) => {
    await close(relay); await close(server); rmSync(f.dir, { recursive: true, force: true }); throw error;
  });
  const realFetch = globalThis.fetch;
  const spy = spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (![upstream, base].some((allowed) => url === allowed || url.startsWith(`${allowed}/`))) throw new Error('Non-fixture transport refused');
    return realFetch(input, init);
  });
  const control = f.control(() => localMigrationIdle(SOURCE, f.dir));
  const start = async (options: { method?: string; headers?: Record<string, string>; body?: string } = {}, sourceId = SOURCE) => {
    opened = Promise.withResolvers<ServerResponse>();
    const response = fetch(`${base}/relay/${sourceId}`, options);
    const remote = await within(opened.promise);
    const arrived = Promise.withResolvers<void>();
    const needed = Buffer.byteLength(initial);
    const text = response.then((value) => {
      let received = 0;
      const body = value.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
        received += chunk.byteLength; controller.enqueue(chunk);
        if (received >= needed) arrived.resolve();
      } }));
      return new Response(body).text();
    });
    await within(response);
    if (needed > 0) await within(arrived.promise);
    return { response, text, remote };
  };
  const freeze = async () => {
    await control.run(SOURCE, 'prepare', f.status.scope, null);
    const record = migrationRecord(SOURCE, f.dir);
    if (record === null) throw new Error('missing record');
    saveMigration({ ...record, phase: 'freezing', move: true }, f.dir);
  };
  const move = () => control.run(SOURCE, 'move', f.status.scope, migrationRecord(SOURCE, f.dir)?.id ?? null);
  return {
    ...f, control, start, freeze, move, requests, remotes,
    idle: () => localMigrationIdle(SOURCE, f.dir),
    journal: () => readFileSync(join(f.dir, `connector-migration-operations-${SOURCE}.json`), 'utf8'),
    configure: (text: string, type = 'text/event-stream', code = 200) => { initial = text; contentType = type; status = code; },
    request: () => fetch(`${base}/relay/${SOURCE}`),
    close: async () => {
      for (const remote of remotes) remote.end();
      await close(relay); await close(server); spy.mockRestore(); rmSync(f.dir, { recursive: true, force: true });
    },
  };
}

export type PassiveFixture = Awaited<ReturnType<typeof passiveFixture>>;
