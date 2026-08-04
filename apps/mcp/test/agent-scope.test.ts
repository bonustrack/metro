import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  callTargetDenied,
  eventInScope,
  lineTargetDenied,
  stationFullyScoped,
} from '../src/db/agent-scope.ts';
import { setAgentMap } from '../src/db/agent-map.ts';

const ONE = new Set([1]);
const TWO = new Set([2]);

beforeEach(() =>
  setAgentMap(
    {
      'xmtp/x1': 1,
      'discord/d1': 1,
      'discord/d2': 2,
      'telegram/t2': 2,
    },
    { 1: 'tony', 2: 'lisa' },
  ),
);
afterAll(() => setAgentMap({}, {}));

describe('lineTargetDenied', () => {
  test('allows a line on an account the scope owns', () => {
    expect(lineTargetDenied(ONE, { line: 'metro://xmtp/x1/conv' })).toBe(false);
  });

  test('denies a line on another agent account', () => {
    expect(lineTargetDenied(ONE, { line: 'metro://telegram/t2/5' })).toBe(true);
    expect(lineTargetDenied(TWO, { line: 'metro://xmtp/x1/conv' })).toBe(true);
  });

  test('denies an unmapped or unparsable line', () => {
    expect(lineTargetDenied(ONE, { line: 'metro://xmtp/ghost/conv' })).toBe(
      true,
    );
    expect(lineTargetDenied(ONE, { line: 'not-a-line' })).toBe(true);
    expect(lineTargetDenied(ONE, { line: 'metro://discord/1' })).toBe(true);
  });

  test('an empty scope owns nothing', () => {
    expect(lineTargetDenied(new Set(), { line: 'metro://xmtp/x1/conv' })).toBe(
      true,
    );
  });

  test('args with no line are not a line target', () => {
    expect(lineTargetDenied(ONE, {})).toBe(false);
    expect(lineTargetDenied(ONE, { line: 42 })).toBe(false);
  });

  test('an account override may not re-route to another agent account', () => {
    expect(
      lineTargetDenied(ONE, { line: 'metro://discord/d1/9', account: 'd2' }),
    ).toBe(true);
    expect(
      lineTargetDenied(ONE, { line: 'metro://discord/d1/9', account: 'd1' }),
    ).toBe(false);
  });

  test('a station mismatch between the route and the line is denied', () => {
    expect(
      lineTargetDenied(ONE, { line: 'metro://xmtp/x1/conv' }, 'discord'),
    ).toBe(true);
    expect(lineTargetDenied(ONE, { line: 'metro://xmtp/x1/conv' }, 'xmtp')).toBe(
      false,
    );
  });
});

describe('stationFullyScoped', () => {
  test('true only when every account of the station is in scope', () => {
    expect(stationFullyScoped(ONE, 'xmtp')).toBe(true);
    expect(stationFullyScoped(ONE, 'discord')).toBe(false);
    expect(stationFullyScoped(new Set([1, 2]), 'discord')).toBe(true);
  });

  test('a station with no accounts is never fully scoped', () => {
    expect(stationFullyScoped(new Set([1, 2]), 'whatsapp')).toBe(false);
  });

  test('a station goes out of reach the moment a second agent joins it', () => {
    setAgentMap({ 'xmtp/x1': 1 }, { 1: 'tony' });
    expect(stationFullyScoped(ONE, 'xmtp')).toBe(true);
    setAgentMap({ 'xmtp/x1': 1, 'xmtp/x2': 2 }, { 1: 'tony', 2: 'lisa' });
    expect(stationFullyScoped(ONE, 'xmtp')).toBe(false);
  });
});

describe('callTargetDenied', () => {
  test('a lined call is judged by the line', () => {
    expect(
      callTargetDenied(ONE, 'discord', { line: 'metro://discord/d1/9' }),
    ).toBe(false);
    expect(
      callTargetDenied(ONE, 'discord', { line: 'metro://discord/d2/9' }),
    ).toBe(true);
  });

  test('a line-less call needs the whole station', () => {
    expect(callTargetDenied(ONE, 'xmtp', {})).toBe(false);
    expect(callTargetDenied(ONE, 'discord', {})).toBe(true);
  });

  test('a line-less call naming an account is judged by that account', () => {
    expect(callTargetDenied(ONE, 'discord', { account: 'd1' })).toBe(false);
    expect(callTargetDenied(ONE, 'discord', { account: 'd2' })).toBe(true);
    expect(callTargetDenied(ONE, 'discord', { account: 'ghost' })).toBe(true);
  });
});

describe('eventInScope', () => {
  test('an owned line reaches only its own agent', () => {
    expect(eventInScope(ONE, 'metro://xmtp/x1/conv')).toBe(true);
    expect(eventInScope(TWO, 'metro://xmtp/x1/conv')).toBe(false);
  });

  test('a line with no owning agent reaches everyone', () => {
    expect(eventInScope(ONE, 'metro://webhook/gh')).toBe(true);
    expect(eventInScope(TWO, 'metro://webhook/gh')).toBe(true);
    expect(eventInScope(TWO, 'metro://claude/org/session')).toBe(true);
  });
});
