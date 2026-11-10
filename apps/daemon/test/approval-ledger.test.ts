import { describe, expect, test } from 'bun:test';
import { approvalId } from '@metro-labs/core/ids';
import { APPROVAL_ID_RE, APPROVAL_PENDING_MAX, APPROVAL_TTL_MS, APPROVAL_USE_MS } from '@metro-labs/http/approval-rules';
import { ASK_KEEP_MS, ASKS_KEPT_MAX, AskLedger, type AskedCall } from '../src/approvals/ledger.ts';

const T0 = Date.parse('2026-11-10T10:00:00.000Z');
const CALL: AskedCall = { tool: 'send', digest: 'digest-a', station: 'telegram-bot', account: 'tb000000001', agent: 'agent000001' };
const ROUTE = { line: undefined, call: undefined };

const opened = (ledger: AskLedger, id: string, call: AskedCall = CALL, at = T0) => {
  const ask = ledger.ask(id, call, ROUTE, at);
  if (ask === undefined) throw new Error(`could not open ${id}`);
  return ask;
};

describe('the approvals the daemon holds for channel calls', () => {
  test('an approval id is five letters the chat reply pattern reads', () => {
    for (let i = 0; i < 200; i += 1) expect(approvalId()).toMatch(APPROVAL_ID_RE);
    expect('abcdl').not.toMatch(APPROVAL_ID_RE);
  });

  test('an approved call runs once, and only for exactly that call', () => {
    const ledger = new AskLedger();
    opened(ledger, 'abcde');
    expect(ledger.judge('abcde', CALL, T0).kind).toBe('waiting');
    expect(ledger.settle('abcde', 'allow', T0 + 1000)?.state).toBe('allow');
    const others: AskedCall[] = [
      { ...CALL, tool: 'delete' },
      { ...CALL, digest: 'digest-b' },
      { ...CALL, station: 'whatsapp' },
      { ...CALL, account: 'tb000000002' },
      { ...CALL, agent: 'agent000002' },
    ];
    for (const other of others) expect(ledger.judge('abcde', other, T0 + 2000)).toEqual({ kind: 'spent', why: 'other' });
    const verdict = ledger.judge('abcde', CALL, T0 + 2000);
    if (verdict.kind !== 'ready') throw new Error(`expected a usable approval, got ${verdict.kind}`);
    expect(ledger.use(verdict.ask, T0 + 2000)).toBe(true);
    expect(ledger.use(verdict.ask, T0 + 2000)).toBe(false);
    expect(ledger.judge('abcde', CALL, T0 + 3000)).toEqual({ kind: 'spent', why: 'used' });
    expect(ledger.judge('zzzzz', CALL, T0)).toEqual({ kind: 'spent', why: 'unknown' });
  });

  test('an approval counts for 10 minutes after the answer, not after the request', () => {
    const ledger = new AskLedger();
    opened(ledger, 'abcde');
    const answeredAt = T0 + 5 * 3_600_000;
    ledger.settle('abcde', 'allow', answeredAt);
    expect(ledger.judge('abcde', CALL, answeredAt + APPROVAL_USE_MS).kind).toBe('ready');
    expect(ledger.judge('abcde', CALL, answeredAt + APPROVAL_USE_MS + 1)).toEqual({ kind: 'spent', why: 'late' });
    expect(ledger.standing(CALL, answeredAt + APPROVAL_USE_MS + 1)).toBeUndefined();
  });

  test('an answer is taken once: a second answer changes nothing', () => {
    const ledger = new AskLedger();
    opened(ledger, 'abcde');
    expect(ledger.settle('abcde', 'deny', T0 + 1)?.state).toBe('deny');
    expect(ledger.settle('abcde', 'allow', T0 + 2)).toBeUndefined();
    expect(ledger.judge('abcde', CALL, T0 + 3).kind).toBe('denied');
    expect(ledger.settle('zzzzz', 'allow', T0)).toBeUndefined();
  });

  test('the same call finds its waiting request, or the approval it has not used yet', () => {
    const ledger = new AskLedger();
    const ask = opened(ledger, 'abcde');
    expect(ledger.standing(CALL, T0)).toBe(ask);
    expect(ledger.standing({ ...CALL, digest: 'digest-b' }, T0)).toBeUndefined();
    ledger.settle('abcde', 'allow', T0 + 1);
    expect(ledger.standing(CALL, T0 + 2)).toBe(ask);
    ledger.use(ask, T0 + 2);
    expect(ledger.standing(CALL, T0 + 3)).toBeUndefined();
    opened(ledger, 'bcdef');
    ledger.settle('bcdef', 'deny', T0 + 4);
    expect(ledger.standing(CALL, T0 + 5)).toBeUndefined();
  });

  test('expired, withdrawn and denied requests never run', () => {
    const ledger = new AskLedger();
    for (const [id, answer] of [['abcde', 'expired'], ['bcdef', 'withdrawn'], ['cdefg', 'deny']] as const) {
      opened(ledger, id, { ...CALL, digest: id });
      ledger.settle(id, answer, T0 + 1);
    }
    expect(ledger.judge('abcde', { ...CALL, digest: 'abcde' }, T0 + 2)).toEqual({ kind: 'spent', why: 'expired' });
    expect(ledger.judge('bcdef', { ...CALL, digest: 'bcdef' }, T0 + 2)).toEqual({ kind: 'spent', why: 'withdrawn' });
    expect(ledger.judge('cdefg', { ...CALL, digest: 'cdefg' }, T0 + 2).kind).toBe('denied');
  });

  test('at most 50 requests wait at once, and an answer makes room', () => {
    const ledger = new AskLedger();
    for (let i = 0; i < APPROVAL_PENDING_MAX; i += 1) opened(ledger, `id${String(i)}`, { ...CALL, digest: `d${String(i)}` });
    expect(ledger.full).toBe(true);
    expect(ledger.ask('extra', { ...CALL, digest: 'extra' }, ROUTE, T0)).toBeUndefined();
    ledger.settle('id0', 'deny', T0 + 1);
    expect(ledger.full).toBe(false);
    expect(ledger.ask('extra', { ...CALL, digest: 'extra' }, ROUTE, T0 + 2)?.id).toBe('extra');
    expect(ledger.ask('extra', { ...CALL, digest: 'again' }, ROUTE, T0 + 2)).toBeUndefined();
  });

  test('answered requests are forgotten after an hour, and never more than 500 are kept', () => {
    const ledger = new AskLedger();
    for (let i = 0; i < ASKS_KEPT_MAX + 20; i += 1) {
      opened(ledger, `id${String(i)}`, { ...CALL, digest: `d${String(i)}` }, T0 + i);
      ledger.settle(`id${String(i)}`, 'deny', T0 + i);
    }
    expect(ledger.size).toBeLessThanOrEqual(ASKS_KEPT_MAX);
    expect(ledger.has('id0')).toBe(false);
    expect(ledger.has(`id${String(ASKS_KEPT_MAX + 19)}`)).toBe(true);
    opened(ledger, 'abcde', CALL, T0 + 1000);
    ledger.sweep(T0 + 1000 + ASK_KEEP_MS);
    expect(ledger.size).toBe(1);
    expect(ledger.judge('abcde', CALL, T0 + 1000 + ASK_KEEP_MS).kind).toBe('waiting');
  });

  test('a request nobody answered stops waiting after 24 hours, even if its prompt was lost', () => {
    const ledger = new AskLedger();
    opened(ledger, 'abcde');
    ledger.sweep(T0 + APPROVAL_TTL_MS);
    expect(ledger.pending).toBe(1);
    ledger.sweep(T0 + APPROVAL_TTL_MS + 5 * 60_000);
    expect(ledger.pending).toBe(0);
    expect(ledger.judge('abcde', CALL, T0 + APPROVAL_TTL_MS + 5 * 60_000)).toEqual({ kind: 'spent', why: 'expired' });
  });
});
