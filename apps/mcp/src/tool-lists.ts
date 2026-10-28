import { errMsg, log } from '@metro-labs/core/log';
import type { RemoteTool } from '@metro-labs/http/connector-tools';
import { readToolListings, saveToolListing, type ToolFailure, type ToolListing } from '@metro-labs/connectors/db/connector-tools';
import type { Database } from '@metro-labs/connectors/db/database';
import { isUndefinedTable } from '@metro-labs/connectors/db/errors';
import { Flights } from './flights.js';

export const TOOL_LIST_TTL_MS = 5 * 60_000;
export const FAILURE_PAUSE_MS = 60_000;
const HELD_MAX = 500;

const EMPTY: ToolListing = { tools: null, listedAt: 0, failure: null, failedAt: 0 };

const newer = (a: ToolListing, b: ToolListing | undefined): ToolListing => (b !== undefined && Math.max(b.listedAt, b.failedAt) > Math.max(a.listedAt, a.failedAt) ? b : a);

export class ToolLists {
  private readonly held = new Map<string, ToolListing>();
  private readonly flights = new Flights<ToolListing>();
  private quiet = false;

  constructor(
    private readonly db: () => Database,
    private readonly now: () => number,
  ) {}

  fresh(listing: ToolListing): boolean {
    return listing.tools !== null && this.now() - listing.listedAt < TOOL_LIST_TTL_MS;
  }

  paused(listing: ToolListing): boolean {
    return listing.failure !== null && listing.failedAt >= listing.listedAt && this.now() - listing.failedAt < FAILURE_PAUSE_MS;
  }

  async preload(connectors: string[]): Promise<void> {
    const missing = connectors.filter((connector) => !this.held.has(connector));
    if (missing.length === 0) return;
    const stored = await this.load(missing);
    for (const connector of missing) this.keep(connector, newer(stored.get(connector) ?? EMPTY, this.held.get(connector)));
  }

  async read(connector: string): Promise<ToolListing> {
    await this.preload([connector]);
    return this.keep(connector, this.held.get(connector) ?? EMPTY);
  }

  refresh(connector: string, list: () => Promise<RemoteTool[]>, failureOf: (err: unknown) => ToolFailure): Promise<ToolListing> {
    return this.flights.run(connector, async () => {
      const known = newer((await this.load([connector])).get(connector) ?? EMPTY, this.held.get(connector));
      if (this.fresh(known) || this.paused(known)) return this.keep(connector, known);
      let next: ToolListing;
      try {
        next = { tools: await list(), listedAt: this.now(), failure: null, failedAt: 0 };
      } catch (err) {
        next = { ...known, failure: failureOf(err), failedAt: this.now() };
      }
      await this.quietly(() => saveToolListing(this.db(), connector, next));
      return this.keep(connector, next);
    });
  }

  private keep(connector: string, listing: ToolListing): ToolListing {
    this.held.delete(connector);
    this.held.set(connector, listing);
    for (const oldest of this.held.keys()) {
      if (this.held.size <= HELD_MAX) break;
      this.held.delete(oldest);
    }
    return listing;
  }

  private async load(connectors: string[]): Promise<Map<string, ToolListing>> {
    return (await this.quietly(() => readToolListings(this.db(), connectors))) ?? new Map();
  }

  private async quietly<T>(work: () => Promise<T>): Promise<T | undefined> {
    try {
      const done = await work();
      if (this.quiet) log.info('mcp: keeping tool lists in the database again');
      this.quiet = false;
      return done;
    } catch (err) {
      if (!this.quiet) {
        if (isUndefinedTable(err)) log.warn('mcp: the connector_tools table does not exist yet, so tool lists stay in memory until api.metro.box migrates');
        else log.warn({ err: errMsg(err) }, 'mcp: could not read or save a tool list, later failures stay quiet until one works');
      }
      this.quiet = true;
      return undefined;
    }
  }
}
