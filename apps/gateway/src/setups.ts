import type { FetchLike } from '@metro-labs/core/stations/oauth';
import type { Database } from '@metro-labs/connectors/db/database';
import { agentModelSetup } from '@metro-labs/connectors/db/model-delivery';
import { orgModelStore } from '@metro-labs/connectors/db/models';
import { agentConnection, agentModelsOf } from '@metro-labs/connectors/model-agent';
import { refreshModelConnection, type ModelRefreshDeps } from '@metro-labs/connectors/model-refresh';
import { deliveredOf, refreshedConnection, setupOf } from '@metro-labs/inference/delivered';
import type { Connection, ModelSetup } from '@metro-labs/inference/model-config';
import type { Caller } from './callers.js';

export const SETUP_TTL_MS = 10_000;
const HELD_MAX = 5_000;

export interface SetupDeps {
  db: () => Database;
  key: Buffer;
  fetch: FetchLike;
  now: () => number;
}

interface Held {
  at: number;
  setup: Promise<ModelSetup>;
}

const keyOf = (caller: Pick<Caller, 'agent' | 'owner'>): string => `${caller.owner}\n${caller.agent}`;

export class Setups {
  private readonly held = new Map<string, Held>();

  constructor(private readonly deps: SetupDeps) {}

  private refreshDeps(): ModelRefreshDeps {
    return { key: this.deps.key, store: orgModelStore(this.deps.db), fetch: this.deps.fetch, now: this.deps.now };
  }

  of(caller: Caller): Promise<ModelSetup> {
    const now = this.deps.now();
    const key = keyOf(caller);
    const seen = this.held.get(key);
    if (seen !== undefined && now - seen.at < SETUP_TTL_MS) return seen.setup;
    if (this.held.size >= HELD_MAX) this.held.clear();
    const setup = this.load(caller);
    this.held.set(key, { at: now, setup });
    setup.catch(() => {
      this.held.delete(key);
    });
    return setup;
  }

  private async load(caller: Caller): Promise<ModelSetup> {
    const models = await agentModelsOf(this.refreshDeps(), await agentModelSetup(this.deps.db(), caller), caller.owner);
    return setupOf(deliveredOf({ ...models }));
  }

  async refresh(caller: Caller, conn: Connection): Promise<Connection | null> {
    const row = await refreshModelConnection(this.refreshDeps(), caller.owner, conn.id, conn.revision);
    this.held.delete(keyOf(caller));
    return refreshedConnection({ ...agentConnection(this.deps.key, row) });
  }
}
