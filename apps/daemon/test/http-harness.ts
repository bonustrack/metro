import type { AddressInfo } from 'node:net';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { makeEmit, startWebhookServer } from '../src/routes/http.ts';
import type { SessionApis } from '../src/routes/session-apis.ts';

export interface BootOptions {
  mcp?: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  monitor?: boolean;
  emit?: ReturnType<typeof makeEmit>;
}

export interface Daemon {
  base: string;
  server: Server;
  close: () => Promise<void>;
}

const ENV = ['METRO_WEBHOOK_PORT', 'METRO_HTTP_HOST'] as const;

const testPort = (): number => 10000 + Math.floor(Math.random() * 20000);

export async function bootDaemon(apis: SessionApis = {}, opts: BootOptions = {}): Promise<Daemon> {
  const saved = ENV.map((key) => [key, process.env[key]] as const);
  process.env.METRO_WEBHOOK_PORT = String(testPort());
  process.env.METRO_HTTP_HOST = '127.0.0.1';
  const server = await startWebhookServer(opts.emit ?? makeEmit(), apis, opts.mcp, opts.monitor ?? false);
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const close = async (): Promise<void> => {
    await new Promise<void>((done) => server.close(() => done()));
    for (const [key, value] of saved)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  };
  return { base, server, close };
}
