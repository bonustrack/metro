import type { FetchLike } from '@metro-labs/core/stations/oauth';
import type { ToolGroup } from '@metro-labs/core/stations/types';
import { ApiError } from '@metro-labs/http/api-error';
import type { DeliveredConnector } from '@metro-labs/http/connector-delivery';
import { MetroApiRefusal } from './metro-api.js';
import { listRemoteTools } from './tools.js';

export const orgUnavailable = (): ApiError => new ApiError('This organization connector is not available. Try again.', 503);
export const orgSignin = (): ApiError => new ApiError('This organization connector needs sign-in again.', 424);
export const orgMissing = (): ApiError => new ApiError('No such organization connector is assigned to this agent.', 404);

export function orgRuntimeError(error: unknown): ApiError {
  if (error instanceof MetroApiRefusal) return error.upstreamStatus === 401 || error.upstreamStatus === 403 ? orgSignin() : orgUnavailable();
  const status = error instanceof ApiError ? error.status : 503;
  if (status === 401 || status === 403 || status === 424) return orgSignin();
  if (status === 404) return orgMissing();
  if (status === 502) return new ApiError('The organization connector could not complete the request.', 502);
  return orgUnavailable();
}

interface DiscoveryGuard {
  fresh: (revision?: string) => Promise<DeliveredConnector>;
  current: () => DeliveredConnector;
  signal: AbortSignal;
  fetch: FetchLike;
}

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TOOLS = 2000;

async function boundedResponse(response: Response, signal: AbortSignal): Promise<Response> {
  const reader = response.body?.getReader();
  if (reader === undefined) return response;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (let part = await reader.read(); !part.done; part = await reader.read()) {
      signal.throwIfAborted();
      size += part.value.length;
      if (size > MAX_BYTES) throw orgUnavailable();
      chunks.push(part.value);
    }
    return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers });
  } finally {
    await reader.cancel();
  }
}

function requestInit(row: DeliveredConnector, init: RequestInit | undefined, scanSignal: AbortSignal): RequestInit & { signal: AbortSignal } {
  const headers = new Headers(init?.headers);
  for (const [name, value] of Object.entries(row.headers)) headers.set(name, value);
  const signals = [scanSignal, AbortSignal.timeout(15_000)];
  if (init?.signal !== undefined && init.signal !== null) signals.push(init.signal);
  return { ...init, headers, redirect: 'manual', signal: AbortSignal.any(signals) };
}

async function discoveryResponse(response: Response, init: RequestInit | undefined, signal: AbortSignal): Promise<Response> {
  if (response.status >= 300) throw new ApiError('The organization connector refused tool discovery.', 502);
  if (init?.method === 'DELETE') return new Response(null, { status: response.status });
  return boundedResponse(response, signal);
}

async function guardedRequest(input: string, init: RequestInit | undefined, guard: DiscoveryGuard, budget: { refreshed: boolean }): Promise<Response> {
  let revision: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    guard.signal.throwIfAborted();
    await guard.fresh(revision);
    guard.signal.throwIfAborted();
    const row = guard.current();
    if (input !== new URL(row.url).toString()) throw orgUnavailable();
    const options = requestInit(row, init, guard.signal);
    const response = await guard.fetch(input, options);
    try {
      guard.current();
      options.signal.throwIfAborted();
      if (response.status === 401 || response.status === 403) {
        if (row.auth !== 'oauth' || budget.refreshed) throw orgSignin();
        budget.refreshed = true;
        revision = row.revision;
        continue;
      }
      return await discoveryResponse(response, init, options.signal);
    } finally {
      if (!response.bodyUsed) await response.body?.cancel();
    }
  }
  throw orgSignin();
}

export async function discoverOrgGroups(url: string, guard: DiscoveryGuard): Promise<Record<string, ToolGroup>> {
  try {
    const failure: { error: ApiError | null } = { error: null };
    const budget = { refreshed: false };
    const send: FetchLike = async (input, init) => {
      try {
        return await guardedRequest(input, init, guard, budget);
      } catch (error) {
        failure.error = orgRuntimeError(error);
        throw failure.error;
      }
    };
    const tools = await listRemoteTools(new URL(url), { kind: 'none' }, send);
    if (failure.error !== null) throw failure.error;
    guard.current();
    guard.signal.throwIfAborted();
    if (tools.length > MAX_TOOLS) throw orgUnavailable();
    return Object.fromEntries(tools.filter((tool) => /^[A-Za-z0-9_.-]{1,128}$/.test(tool.name)).map((tool) => [tool.name, tool.readOnly ? 'read' : 'write']));
  } catch (error) {
    throw orgRuntimeError(error);
  }
}
