import { describe, expect, test } from 'bun:test';
import { stateOf, toSession } from '../src/api/attach-session.ts';
import { microsoftReturn, outcomeOf, parsePending, planReturn, type PendingSignIn } from '../src/api/outlook-return.ts';

const ENTRY: PendingSignIn = {
  state: 'st-1',
  agentsBase: 'https://metro-abc.tail.ts.net/api/agents',
  agentId: 'agent000001',
  attachId: 'as_0123456789012345678901',
  backHash: '#/stage-labs/andy/channels',
  startedAt: 1_000,
};

describe('reading what Microsoft sent back', () => {
  test('a code with its state', () => {
    expect(microsoftReturn('?code=abc&state=st-1&session_state=x')).toEqual({ kind: 'code', code: 'abc', state: 'st-1' });
  });

  test('an error with its description', () => {
    expect(microsoftReturn('?error=access_denied&error_description=AADSTS65004%3A+declined&state=st-1')).toEqual({
      kind: 'error',
      error: 'access_denied',
      description: 'AADSTS65004: declined',
      state: 'st-1',
    });
  });

  test('an ordinary page load is not a return', () => {
    expect(microsoftReturn('')).toBeNull();
    expect(microsoftReturn('?code=abc')).toBeNull();
  });
});

describe('matching the return with the sign-in that started it', () => {
  test('a known state posts the code to that box and that attach session', () => {
    const plan = planReturn({ kind: 'code', code: 'abc', state: 'st-1' }, [ENTRY], 2_000);
    expect(plan).toEqual({ kind: 'post', entry: ENTRY, body: { code: 'abc', state: 'st-1' } });
  });

  test('an unknown or stale state says the link expired', () => {
    expect(planReturn({ kind: 'code', code: 'abc', state: 'other' }, [ENTRY], 2_000)).toEqual({ kind: 'expired' });
    expect(planReturn({ kind: 'code', code: 'abc', state: 'st-1' }, [ENTRY], 1_000 + 16 * 60_000)).toEqual({ kind: 'expired' });
  });

  test('an error return is posted to the session so both tabs show it', () => {
    const plan = planReturn({ kind: 'error', error: 'access_denied', description: 'no', state: 'st-1' }, [ENTRY], 2_000);
    expect(plan).toEqual({ kind: 'post', entry: ENTRY, body: { state: 'st-1', error: 'access_denied', errorDescription: 'no' } });
  });

  test('an error return with no sign-in left shows a plain sentence', () => {
    expect(planReturn({ kind: 'error', error: 'access_denied', description: '', state: 'gone' }, [], 2_000)).toEqual({
      kind: 'refused',
      message: 'The sign-in was declined, so nothing was connected.',
    });
    expect(planReturn({ kind: 'error', error: 'invalid_request', description: 'AADSTS50011: bad redirect\r\nTrace', state: '' }, [], 0)).toEqual({
      kind: 'refused',
      message: 'Microsoft refused the sign-in: AADSTS50011: bad redirect',
    });
  });

  test('the stored list survives junk', () => {
    expect(parsePending(JSON.stringify([ENTRY, { state: '' }, 3]))).toEqual([ENTRY]);
    expect(parsePending('not json')).toEqual([]);
    expect(parsePending(null)).toEqual([]);
  });
});

describe('the attach session on the page', () => {
  const base = { attachId: ENTRY.attachId, station: 'outlook', status: 'pending', prompt: 'p' };

  test('the browser step carries the authorize link and its state', () => {
    const url = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=c&state=st-9';
    const session = toSession({ ...base, step: 'browser', authorizeUrl: url });
    expect(session.step).toBe('browser');
    expect(session.authorizeUrl).toBe(url);
    expect(stateOf(url)).toBe('st-9');
    expect(stateOf('not a url')).toBe('');
  });

  test('a box on beta.175 answers the device step, which still reads as before', () => {
    const session = toSession({ ...base, step: 'device', userCode: 'XK7P9QRT', verificationUri: 'https://microsoft.com/devicelogin' });
    expect(session).toMatchObject({ step: 'device', userCode: 'XK7P9QRT', authorizeUrl: null });
  });

  test('a settled session becomes the outcome the return tab shows', () => {
    expect(outcomeOf(toSession({ ...base, status: 'done' }), '#/x')).toEqual({ ok: true });
    expect(outcomeOf(toSession({ ...base, status: 'failed', error: 'nope' }), '#/x')).toEqual({ ok: false, message: 'nope', backHash: '#/x' });
    expect(outcomeOf(toSession(base), '#/x')).toBeNull();
  });
});
