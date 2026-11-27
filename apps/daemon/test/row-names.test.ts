import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { log } from '@metro-labs/core/log';
import { approvalAgentOf, approvalLinkOf, setApprovalAgent } from '../src/approvals/link.ts';
import { newAgentKey, type AgentKey } from '../src/connectors/agent-key.ts';
import type { MetroApi } from '../src/connectors/metro-api.ts';
import { rowNames, RowNamesWatch, stopRowNames, watchRowNames } from '../src/connectors/row-names.ts';
import { setAgentMap } from '../src/agents/map.ts';
import { approvalNotice } from '../src/mcp/permission-prompt.ts';
import { waitFor } from './wait.ts';

const ORG = 'org_01ROWNAMES0000000';
const ROW = 'row00000001';
const AGENT = 'local-agent-1';
const ENROLLMENT = { server: ROW, organization: ORG, at: '2026-11-16T00:00:00.000Z' };

interface Seen {
  url: string;
  method: string;
  authorization: string;
}

let seen: Seen[] = [];
let answer: (key: AgentKey) => { status: number; body: unknown } = () => ({ status: 503, body: { error: 'not set' } });
let owner: string | null = ORG;
let key: AgentKey | null = null;

const enrolledKey = (): AgentKey => ({ ...newAgentKey(), enrollment: ENROLLMENT });

const api: MetroApi = {
  base: 'https://api.metro.box',
  fetch: (url, init) => {
    seen.push({ url, method: String(init.method), authorization: String((init.headers as Record<string, string>).authorization) });
    const { status, body } = answer(key ?? newAgentKey());
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  },
  now: () => Date.now(),
};

const session = (current: AgentKey, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ server: ROW, organization: ORG, keyId: current.keyId, enrolledAt: '2026-11-16T00:00:00.000Z', ...extra });
const NAMED = { organizationSlug: 'stage-labs', agentSlug: 'emma', agentName: 'Emma' };
const watch = (): RowNamesWatch => new RowNamesWatch({ owner: () => owner, key: () => key, api });
const linkNow = (): string => {
  setApprovalAgent(() => approvalAgentOf(owner, key?.enrollment, rowNames()));
  return approvalLinkOf('jkmnp');
};

beforeEach(async () => {
  seen = [];
  owner = ORG;
  key = null;
  await watch().refresh();
});

afterEach(() => {
  stopRowNames();
});

afterAll(() => {
  setApprovalAgent(() => ({ owner: null, agent: null }));
  setAgentMap({}, {});
});

describe('the names of this agent on metro.box', () => {
  test('are read with a signed GET of the session once enrolled, and never before or for another organization', async () => {
    await watch().refresh();
    owner = 'org_01SOMEONEELSE0000';
    key = enrolledKey();
    await watch().refresh();
    expect(seen).toEqual([]);
    expect(rowNames()).toBeNull();
    owner = ORG;
    answer = (current) => ({ status: 200, body: session(current, NAMED) });
    await watch().refresh();
    expect(seen).toEqual([{ url: 'https://api.metro.box/api/agents/session', method: 'GET', authorization: expect.stringMatching(/^MetroAgent /) as unknown as string }]);
    expect(rowNames()).toEqual({ server: ROW, organization: ORG, ...NAMED });
  });

  test('an older api.metro.box without them, and values that are not slugs or names, read as none', async () => {
    key = enrolledKey();
    answer = (current) => ({ status: 200, body: session(current) });
    await watch().refresh();
    expect(rowNames()).toEqual({ server: ROW, organization: ORG, organizationSlug: null, agentSlug: null, agentName: null });
    answer = (current) => ({ status: 200, body: session(current, { organizationSlug: 'Stage Labs', agentSlug: 'settings', agentName: ' \n\u0007 ' }) });
    await watch().refresh();
    expect(rowNames()).toEqual({ server: ROW, organization: ORG, organizationSlug: null, agentSlug: null, agentName: null });
    answer = (current) => ({ status: 200, body: session(current, { agentName: `Em\nma\u0007 ${'x'.repeat(300)}` }) });
    await watch().refresh();
    expect(rowNames()?.agentName).toBe(`Em ma ${'x'.repeat(114)}`);
  });

  test('a failure keeps the last answer and only logs once, an answer for another agent is not taken, and agent_key_missing clears them', async () => {
    key = enrolledKey();
    answer = (current) => ({ status: 200, body: session(current, NAMED) });
    await watch().refresh();
    const warnings = spyOn(log, 'warn');
    try {
      const failing = watch();
      answer = () => ({ status: 503, body: { error: 'down for a moment' } });
      await failing.refresh();
      await failing.refresh();
      expect(rowNames()?.agentName).toBe('Emma');
      expect(warnings).toHaveBeenCalledTimes(1);
      answer = (current) => ({ status: 200, body: { ...session(current, { agentName: 'Mallory' }), server: 'row00000009' } });
      await watch().refresh();
      expect(rowNames()?.agentName).toBe('Emma');
      answer = () => ({ status: 401, body: { error: 'not enrolled', code: 'agent_key_missing' } });
      await watch().refresh();
      expect(rowNames()).toBeNull();
    } finally {
      warnings.mockRestore();
    }
  });

  test('the watch reads them at once when it starts, then on its timer', async () => {
    key = enrolledKey();
    answer = (current) => ({ status: 200, body: session(current, NAMED) });
    watchRowNames({ owner: () => owner, key: () => key, api }, 40);
    await waitFor(() => seen.length >= 3);
    stopRowNames();
    expect(rowNames()?.agentSlug).toBe('emma');
  });
});

describe('the approval link and the chat text', () => {
  test('the link uses the slugs of this row, and ids when they are unknown, belong to another row or another organization', async () => {
    expect(linkNow()).toBe(`https://metro.box/#/${ORG}/agents`);
    key = enrolledKey();
    expect(linkNow()).toBe(`https://metro.box/#/${ORG}/${ROW}/approvals/jkmnp`);
    answer = (current) => ({ status: 200, body: session(current, NAMED) });
    await watch().refresh();
    expect(linkNow()).toBe('https://metro.box/#/stage-labs/emma/approvals/jkmnp');
    key = { ...key, enrollment: { ...ENROLLMENT, server: 'row00000002' } };
    expect(linkNow()).toBe(`https://metro.box/#/${ORG}/row00000002/approvals/jkmnp`);
    key = { ...key, enrollment: ENROLLMENT };
    owner = 'org_01SOMEONEELSE0000';
    expect(linkNow()).toBe('https://metro.box/#/org_01SOMEONEELSE0000/agents');
  });

  test('the chat names the agent as metro.box does, else by its local name, else "the agent"', async () => {
    setAgentMap({ 'telegram-bot/tb1': AGENT }, { [AGENT]: 'Andy' });
    key = enrolledKey();
    answer = (current) => ({ status: 200, body: session(current, NAMED) });
    await watch().refresh();
    linkNow();
    expect(approvalNotice('jkmnp', { tool: 'draft', place: 'Gmail (fabien@bonustrack.co)' })).toBe('Approval needed: Emma wants to run draft on Gmail (fabien@bonustrack.co).\nApprove or deny it on metro.box: https://metro.box/#/stage-labs/emma/approvals/jkmnp');
    answer = (current) => ({ status: 200, body: session(current, { ...NAMED, agentName: 'n'.repeat(90) }) });
    await watch().refresh();
    expect(approvalNotice('jkmnp', { tool: 'draft' })).toStartWith(`Approval needed: ${'n'.repeat(59)}… wants to run draft.`);
    answer = (current) => ({ status: 200, body: session(current) });
    await watch().refresh();
    expect(approvalNotice('jkmnp', { tool: 'draft' })).toBe(`Approval needed: Andy wants to run draft.\nApprove or deny it on metro.box: https://metro.box/#/${ORG}/${ROW}/approvals/jkmnp`);
    setAgentMap({ 'telegram-bot/tb1': AGENT }, { [AGENT]: AGENT });
    expect(approvalNotice('jkmnp', { tool: 'draft' })).toStartWith('Approval needed: the agent wants to run draft.');
  });
});
