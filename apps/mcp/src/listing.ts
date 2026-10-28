import { errMsg, log } from '@metro-labs/core/log';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { ApiError } from '@metro-labs/http/api-error';
import { listRemoteTools, type RemoteTool } from '@metro-labs/http/connector-tools';
import { publicTools } from '@metro-labs/connectors/catalogue';
import type { ToolListing } from '@metro-labs/connectors/db/connector-tools';
import type { DeliveryIdentity } from '@metro-labs/connectors/db/connector-delivery';
import type { AgentConnector } from './catalog.js';
import { withCredential } from './credential.js';
import type { McpDeps } from './deps.js';
import { CallError } from './errors.js';
import type { ToolGroup } from './policy.js';

export const FIRST_LIST_WAIT_MS = 8_000;
const LIST_DEADLINE_MS = 30_000;

export interface ConnectorListing {
  status: 'ok' | 'listing' | 'signin' | 'unavailable';
  tools: RemoteTool[];
  listedAt?: number;
  error?: string;
}

export function failureOf(err: unknown, name: string): CallError {
  if (err instanceof CallError) return err;
  if (err instanceof ApiError) return new CallError('unavailable', err.status === 429 ? err.message : `${name} could not be reached: ${err.message}`);
  log.warn({ err: errMsg(err) }, 'mcp: a connector request failed');
  return new CallError('unavailable', `Metro could not use ${name} right now. Try again in a few minutes.`);
}

export const groupsOf = (tools: RemoteTool[]): Record<string, ToolGroup> => Object.fromEntries(tools.map((tool) => [tool.name, tool.readOnly ? 'read' : 'write']));

const bounded = (fetch: FetchLike): FetchLike => {
  const deadline = AbortSignal.timeout(LIST_DEADLINE_MS);
  return (url, init) => fetch(url, { ...init, signal: init?.signal === undefined || init.signal === null ? deadline : AbortSignal.any([deadline, init.signal]) });
};

function refresh(deps: McpDeps, identity: DeliveryIdentity, connector: AgentConnector): Promise<ToolListing> {
  const list = (): Promise<RemoteTool[]> => {
    const fetch = bounded(deps.fetch);
    return withCredential(deps, identity, connector.id, async (target) => publicTools(await listRemoteTools(target.url, target.auth, fetch), target.secret));
  };
  return deps.toolLists.refresh(connector.id, list, (err) => {
    const failure = failureOf(err, connector.name);
    return failure.code === 'not_found' ? { code: 'unavailable', message: `Metro could not use ${connector.name} right now. Try again in a few minutes.` } : { code: failure.code, message: failure.message };
  });
}

function viewOf(listing: ToolListing): ConnectorListing {
  const failure = listing.failure !== null && listing.failedAt >= listing.listedAt ? listing.failure : null;
  if (listing.tools !== null) return { status: 'ok', tools: listing.tools, listedAt: listing.listedAt, ...(failure === null ? {} : { error: failure.message }) };
  if (failure === null) return { status: 'listing', tools: [] };
  return { status: failure.code === 'signin' ? 'signin' : 'unavailable', tools: [], error: failure.message };
}

async function within(work: Promise<ToolListing>, ms: number): Promise<ToolListing | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
    }, ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

interface ListingWait {
  waitMs?: number;
  fresh?: boolean;
}

export async function connectorListing(deps: McpDeps, identity: DeliveryIdentity, connector: AgentConnector, wait: ListingWait = {}): Promise<ConnectorListing> {
  const known = await deps.toolLists.read(connector.id);
  if (deps.toolLists.fresh(known) || deps.toolLists.paused(known)) return viewOf(known);
  const running = refresh(deps, identity, connector);
  running.catch((err: unknown) => {
    log.warn({ connector: connector.id, err: errMsg(err) }, 'mcp: a tool list refresh failed');
  });
  if (known.tools !== null && wait.fresh !== true) return viewOf(known);
  const done = await within(running, wait.waitMs ?? deps.listWaitMs);
  if (done !== null) return viewOf(done);
  return known.tools !== null ? viewOf(known) : { status: 'listing', tools: [], error: `Metro is still reading the tools of ${connector.name}. Try again in a moment.` };
}
