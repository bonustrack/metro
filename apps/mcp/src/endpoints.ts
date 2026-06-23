import { join } from 'node:path';
import { STATE_DIR } from './paths.js';
import { readJson } from './secure-fs.js';

const WEBHOOKS_FILE = join(STATE_DIR, 'webhooks.json');

export interface Endpoint {
  id: string;
  label: string;
  secret?: string;
  session?: string;
  createdAt: string;
}
interface Store {
  endpoints: Endpoint[];
}

export const webhookPort = (): number =>
  Number(process.env.METRO_WEBHOOK_PORT) || 8420;

function readWebhooks(): Store {
  return readJson<Store>(WEBHOOKS_FILE, { endpoints: [] });
}

export const listEndpoints = (): Endpoint[] => readWebhooks().endpoints;
export const findEndpoint = (id: string): Endpoint | undefined =>
  readWebhooks().endpoints.find((e) => e.id === id);
