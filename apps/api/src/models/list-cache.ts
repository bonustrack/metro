import { createHash } from 'node:crypto';
import { errMsg, log } from '@metro-labs/core/log';

export const LIST_TTL_MS = 60 * 60_000;
const KEPT_MAX = 2000;

export interface ListedModel {
  id: string;
  name: string;
  price?: { prompt: number | null; completion: number | null };
  zdr?: boolean;
}

export class ListCache {
  private readonly kept = new Map<string, { at: number; list: ListedModel[] }>();

  constructor(private readonly now: () => number) {}

  async get(key: string, load: () => Promise<ListedModel[]>): Promise<ListedModel[]> {
    const hit = this.kept.get(key);
    if (hit !== undefined && this.now() - hit.at < LIST_TTL_MS) return hit.list;
    try {
      const list = await load();
      this.keep(key, list);
      return list;
    } catch (err) {
      if (hit === undefined) throw err;
      log.warn({ err: errMsg(err) }, 'models: the provider would not list its models, so the last list it gave stands');
      return hit.list;
    }
  }

  private keep(key: string, list: ListedModel[]): void {
    const oldest = this.kept.keys().next();
    if (!this.kept.has(key) && this.kept.size >= KEPT_MAX && oldest.done !== true) this.kept.delete(oldest.value);
    this.kept.set(key, { at: this.now(), list });
  }
}

export const fingerprint = (...parts: string[]): string => createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
