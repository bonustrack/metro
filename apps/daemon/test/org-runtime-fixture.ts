import { expect } from 'bun:test';
import { ApiError } from '@metro-labs/http/api-error';
import { agentSignatureValid, readAgentProof } from '@metro-labs/http/agent-signature';
import { sealConnectorDelivery, type DeliveryContext, type DeliverySnapshot } from '@metro-labs/http/connector-delivery';
import { newAgentKey } from '../src/connectors/agent-key.ts';
import { registerConnectors, type GateRow } from '../src/connectors/gates.ts';
import { OrgConnectorRuntime } from '../src/connectors/org-runtime.ts';
import { OrgConnectorSync } from '../src/connectors/org-sync.ts';
import type { MigrationRuntimeMapping } from '../src/connectors/migration-guard.ts';

export const OWNER = 'org_01AGENTOWNER00000';
export const ID = 'conn0000001';
export const RELAY_ID = `org-${ID}`;
export const revision = (value: number): string => Buffer.alloc(32, value).toString('base64url');
const AGENT = 'agent000001';

export function enrolledKey() {
  return { ...newAgentKey(), enrollment: { organization: OWNER, server: AGENT, at: '2026-10-11T00:00:00.000Z' } };
}

interface VendorCall {
  method: string;
  rpc: string;
  body: Record<string, unknown>;
  headers: Headers;
  signal: AbortSignal;
  checks: number;
}

export interface RuntimeFixture {
  state: {
    owner: string | null;
    key: ReturnType<typeof enrolledKey>;
    live: boolean;
    syncEnabled: boolean;
    now: number;
    monotonic: number;
    lease: number;
    rows: DeliverySnapshot['connectors'];
    deliver: ((context: DeliveryContext, snapshot: DeliverySnapshot) => Promise<Response>) | null;
    vendor: ((call: VendorCall) => Promise<Response | null>) | null;
  };
  sync: OrgConnectorSync;
  runtime: OrgConnectorRuntime;
  calls: Record<string, unknown>[];
  vendors: VendorCall[];
  publications: GateRow[][];
  close: () => void;
}

function answer(call: VendorCall): Response {
  if (call.method === 'DELETE') return new Response(null, { status: 204 });
  if (call.rpc === 'initialize') return Response.json({ result: { protocolVersion: '2025-11-25' } }, { headers: { 'mcp-session-id': 'discovery-session' } });
  if (call.rpc === 'notifications/initialized') return new Response(null, { status: 202 });
  const cursor = (call.body.params as Record<string, unknown>).cursor;
  return Response.json({ result: cursor === 'second' ? { tools: [{ name: 'write_item' }] } : { tools: [{ name: 'read_item', annotations: { readOnlyHint: true } }], nextCursor: 'second' } });
}

export async function runtimeFixture(mapping?: () => MigrationRuntimeMapping): Promise<RuntimeFixture> {
  const state: RuntimeFixture['state'] = {
    owner: OWNER, key: enrolledKey(), live: true, syncEnabled: true, now: 1_800_000_000_000, monotonic: 1000, lease: 90_000,
    rows: [{ id: ID, name: 'Org MCP', url: 'https://vendor.example/mcp?private=org-url-secret', auth: 'oauth', headers: { Authorization: 'Bearer org-access-secret' }, policy: { write: 'deny' }, revision: revision(1), state: 'ready' }],
    deliver: null, vendor: null,
  };
  const calls: Record<string, unknown>[] = [];
  const vendors: VendorCall[] = [];
  const publications: GateRow[][] = [];
  const sync = new OrgConnectorSync({
    owner: () => state.owner, key: () => state.key, enabled: () => state.syncEnabled, monotonic: () => state.monotonic,
    api: { base: 'https://api.metro.test', now: () => state.now, fetch: async (url, init) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push(body);
      const proof = readAgentProof(new Headers(init.headers).get('authorization') ?? undefined);
      expect(proof).not.toBeNull();
      if (proof === null) throw new Error('Missing proof');
      expect(agentSignatureValid({ method: 'POST', host: new URL(url).host, path: new URL(url).pathname + new URL(url).search, body: Buffer.from(String(init.body)) }, proof, state.key.signingKey)).toBe(true);
      const context = { owner: OWNER, agent: AGENT, keyId: state.key.keyId, requestId: String(body.requestId) };
      const snapshot: DeliverySnapshot = { version: 1, issuedAt: state.now, expiresAt: state.now + state.lease, connectors: structuredClone(state.rows) };
      return state.deliver === null ? Response.json({ sealed: sealConnectorDelivery(state.key.sealingKey, context, snapshot) }) : state.deliver(context, snapshot);
    } },
  });
  const runtime = new OrgConnectorRuntime(sync, { enabled: () => state.live, mapping, publish: (rows) => {
    publications.push(structuredClone([...rows]));
    registerConnectors(rows);
  }, fetch: async (_url, init) => {
    expect(init?.redirect).toBe('manual');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    const call: VendorCall = { method: init?.method ?? '', rpc: String(body.method ?? ''), body, headers: new Headers(init?.headers), signal: init?.signal ?? new AbortController().signal, checks: calls.length };
    vendors.push(call);
    return (await state.vendor?.(call)) ?? answer(call);
  } });
  await sync.sync();
  return { state, sync, runtime, calls, vendors, publications, close: () => { runtime.stop(); sync.invalidate(); registerConnectors([]); } };
}

export async function expectStatus(work: () => unknown | Promise<unknown>, status: number): Promise<void> {
  let caught: unknown;
  try { await work(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(ApiError);
  expect((caught as ApiError).status).toBe(status);
  expect(String(caught)).not.toContain('org-access-secret');
  expect(String(caught)).not.toContain('org-url-secret');
  expect(String(caught)).not.toContain('vendor.example');
}
