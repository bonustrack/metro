import { inArray } from 'drizzle-orm';
import { isRecord } from '@metro-labs/core/is-record';
import type { RemoteTool } from '@metro-labs/http/connector-tools';
import type { Database } from './database.js';
import { connectorTools } from './schema.js';

const FAILURE_MAX = 1000;
const CODE_MAX = 32;

export interface ToolFailure {
  code: string;
  message: string;
}

export interface ToolListing {
  tools: RemoteTool[] | null;
  listedAt: number;
  failure: ToolFailure | null;
  failedAt: number;
}

const isTool = (value: unknown): value is RemoteTool =>
  isRecord(value) && typeof value.name === 'string' && typeof value.title === 'string' && typeof value.description === 'string' && typeof value.readOnly === 'boolean';

function toolsOf(text: string | null): RemoteTool[] | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) && parsed.every(isTool) ? parsed : null;
  } catch {
    return null;
  }
}

function listingOf(row: typeof connectorTools.$inferSelect): ToolListing {
  const tools = toolsOf(row.tools);
  const failure = row.failureCode === null || row.failure === null ? null : { code: row.failureCode, message: row.failure };
  return { tools, listedAt: tools === null ? 0 : (row.listedAt ?? 0), failure, failedAt: failure === null ? 0 : (row.failedAt ?? 0) };
}

export async function readToolListings(db: Database, connectors: string[]): Promise<Map<string, ToolListing>> {
  if (connectors.length === 0) return new Map();
  const rows = await db.select().from(connectorTools).where(inArray(connectorTools.connector, connectors));
  return new Map(rows.map((row) => [row.connector, listingOf(row)]));
}

export async function saveToolListing(db: Database, connector: string, listing: ToolListing): Promise<void> {
  const failure = listing.failure === null ? { failureCode: null, failure: null, failedAt: null } : { failureCode: listing.failure.code.slice(0, CODE_MAX), failure: listing.failure.message.slice(0, FAILURE_MAX), failedAt: listing.failedAt };
  const tools = listing.tools === null ? { tools: null, listedAt: null } : { tools: JSON.stringify(listing.tools), listedAt: listing.listedAt };
  await db.insert(connectorTools).values({ connector, ...tools, ...failure }).onConflictDoUpdate({ target: connectorTools.connector, set: { ...tools, ...failure } });
}
