import { ApiError } from '@metro-labs/http/api-error';
import { connectorAad, openWith, sealWith } from './envelope.js';
import type { KeyWrapper } from './key-wrappers.js';

const CACHE_MS = 5 * 60_000;
const CACHE_MAX = 1000;
const SEALED_MAX = 64 * 1024;

export interface ConnectorKeyRow {
  owner: string;
  wrapped: string;
  wrapping: string;
  createdAt: string;
}

export interface ConnectorKeyStore {
  find: (owner: string) => Promise<ConnectorKeyRow | null>;
  insert: (row: ConnectorKeyRow) => Promise<void>;
}

export interface KeyringDeps {
  wrapper: KeyWrapper;
  store: ConnectorKeyStore;
  now: () => number;
}

interface Held {
  key: Buffer;
  until: number;
}

export class KeyringError extends ApiError {}

export class Keyring {
  private readonly held = new Map<string, Held>();
  private readonly pending = new Map<string, Promise<Buffer>>();

  constructor(private readonly deps: KeyringDeps) {}

  async seal(owner: string, connectorId: string, value: unknown): Promise<string> {
    const plain = Buffer.from(JSON.stringify(value), 'utf8');
    if (plain.length > SEALED_MAX) throw new KeyringError('connector settings are too large to keep', 413);
    return sealWith(await this.dataKey(owner), connectorAad(owner, connectorId), plain);
  }

  async open(owner: string, connectorId: string, sealed: string): Promise<unknown> {
    const plain = openWith(await this.dataKey(owner), connectorAad(owner, connectorId), sealed);
    return JSON.parse(plain.toString('utf8')) as unknown;
  }

  private dataKey(owner: string): Promise<Buffer> {
    const hit = this.held.get(owner);
    if (hit !== undefined && hit.until > this.deps.now()) return Promise.resolve(hit.key);
    this.held.delete(owner);
    const waiting = this.pending.get(owner);
    if (waiting !== undefined) return waiting;
    const loading = this.load(owner).then((key) => {
      this.keep(owner, key);
      return key;
    }).finally(() => {
      this.pending.delete(owner);
    });
    this.pending.set(owner, loading);
    return loading;
  }

  private keep(owner: string, key: Buffer): void {
    const oldest = this.held.size >= CACHE_MAX ? this.held.keys().next() : null;
    if (oldest !== null && oldest.done !== true) this.held.delete(oldest.value);
    this.held.set(owner, { key, until: this.deps.now() + CACHE_MS });
  }

  private async load(owner: string): Promise<Buffer> {
    const held = await this.deps.store.find(owner);
    if (held !== null) return this.unwrap(owner, held);
    const made = await this.deps.wrapper.create(owner);
    await this.deps.store.insert({ owner, wrapped: made.wrapped, wrapping: this.deps.wrapper.id, createdAt: new Date(this.deps.now()).toISOString() });
    const kept = await this.deps.store.find(owner);
    if (kept === null) throw new KeyringError('could not keep the connector key of this organization', 500);
    if (kept.wrapped === made.wrapped) return made.key;
    made.key.fill(0);
    return this.unwrap(owner, kept);
  }

  private unwrap(owner: string, row: ConnectorKeyRow): Promise<Buffer> {
    if (row.wrapping !== this.deps.wrapper.id)
      return Promise.reject(new KeyringError(`the connector key of this organization was made with ${row.wrapping}, and Metro now uses ${this.deps.wrapper.id}`, 500));
    return this.deps.wrapper.unwrap(owner, row.wrapped);
  }
}
