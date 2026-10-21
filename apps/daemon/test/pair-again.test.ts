import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localPairAgain } from '../src/agents/file-admin.ts';
import { finishPairAgain, pairAgainInput } from '../src/routes/pair-again.ts';
import { AttachSessions, type AttachOwner, type AttachView } from '../src/stations/attach-session.ts';
import type { DriverHooks } from '../src/stations/attach-driver.ts';

const AGENT = 'agentPair01';
const OWNER: AttachOwner = { agentId: AGENT };
const PHONE = '447700900123';

const account = {
  station: 'whatsapp',
  id: 'waLisa00001',
  allowlist: ['33612345678@s.whatsapp.net', '1234567890@lid'],
  approvers: ['33612345678@s.whatsapp.net'],
  enabled: false,
  policy: { write: 'ask', tools: { delete: 'deny' } },
  config: { phone: PHONE, credentials: { creds: 'removed-device' } },
};

const agentFile = {
  version: 1,
  id: AGENT,
  key: 'mk_pairpairpairpairpairpairpairpair',
  stations: [account, { station: 'telegram-bot', id: 'tgBot000001', allowlist: ['*'], enabled: true, config: { token: '1:a' } }],
};

let dir = '';
const saved = process.env.METRO_AGENTS_DIR;

const stored = (): typeof agentFile => JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8')) as typeof agentFile;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-pair-again-'));
  process.env.METRO_AGENTS_DIR = dir;
  writeFileSync(join(dir, 'agent.json'), JSON.stringify(agentFile));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.METRO_AGENTS_DIR;
  else process.env.METRO_AGENTS_DIR = saved;
});

describe('pairing a WhatsApp channel again', () => {
  test('only the credentials change: the id, people, approvers, policy and the Receive switch stay', () => {
    const ref = localPairAgain(AGENT, 'whatsapp', account.id, 'phone', { phone: PHONE, credentials: { creds: 'new-device' } }, dir);
    expect(ref).toEqual({ agentId: AGENT, station: 'whatsapp', accountId: account.id });
    const after = stored();
    expect(after.stations).toHaveLength(2);
    expect(after.stations[0]).toEqual({ ...account, config: { phone: PHONE, credentials: { creds: 'new-device' } } });
    expect(after.stations[1]).toEqual(agentFile.stations[1]);
  });

  test('another phone number is refused and nothing is written', () => {
    expect(() => localPairAgain(AGENT, 'whatsapp', account.id, 'phone', { phone: '447700900999', credentials: { creds: 'x' } }, dir)).toThrow(
      'This channel is 447700900123, not 447700900999. Nothing was changed.',
    );
    expect(() => localPairAgain(AGENT, 'whatsapp', account.id, 'phone', { credentials: { creds: 'x' } }, dir)).toThrow('Nothing was changed.');
    expect(stored()).toEqual(agentFile);
  });

  test('a channel removed while the phone was pairing is not brought back', () => {
    expect(() => localPairAgain(AGENT, 'whatsapp', 'waGone00001', 'phone', { phone: PHONE }, dir)).toThrow('This channel is gone');
    expect(stored()).toEqual(agentFile);
  });

  test('the pairing is told which number the channel is, whatever the request says', () => {
    expect(pairAgainInput(OWNER, 'whatsapp', account.id, { phone: '', expect: '1' })).toEqual({ phone: '', expect: PHONE });
    expect(() => pairAgainInput(OWNER, 'whatsapp', 'waGone00001', {})).toThrow('No such channel');
    expect(() => pairAgainInput(OWNER, 'telegram-bot', 'tgBot000001', {})).toThrow('telegram-bot cannot pair again');
    expect(() => finishPairAgain(OWNER, 'telegram-bot', 'tgBot000001', { token: '2:b' })).toThrow('cannot pair again');
    finishPairAgain(OWNER, 'whatsapp', account.id, { phone: PHONE, credentials: { creds: 'new' } });
    expect(stored().stations[0]?.config).toEqual({ phone: PHONE, credentials: { creds: 'new' } });
  });
});

describe('an attach session that pairs an account again', () => {
  test('the account id reaches both the pairing and the store, and the view names that account', async () => {
    const seen: { started?: string; input?: Record<string, unknown>; completed?: string } = {};
    let hooks: DriverHooks | null = null;
    const sessions = new AttachSessions({
      authorize: () => Promise.resolve(),
      start: (_station, input, h, _owner, repair) => {
        hooks = h;
        seen.started = repair;
        seen.input = input;
        return Promise.resolve({ prompt: { step: 'scan', prompt: 'scan' }, driver: { submit: () => Promise.resolve(), cancel: () => Promise.resolve() } });
      },
      complete: (_owner, _station, _config, active, repair) => {
        seen.completed = repair;
        if (!active()) throw new Error('inactive');
        return Promise.resolve({ accountId: repair ?? 'new', activated: true });
      },
    });
    const started = await sessions.start(OWNER, 'whatsapp', { phone: '' }, account.id);
    expect(seen).toMatchObject({ started: account.id, input: { phone: '' } });
    const done = hooks as DriverHooks | null;
    done?.done({ config: { phone: PHONE, credentials: {} }, identity: { phone: PHONE } });
    let view: AttachView = sessions.view(OWNER, started.attachId);
    for (let i = 0; i < 50 && view.status === 'pending'; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
      view = sessions.view(OWNER, started.attachId);
    }
    expect(view).toMatchObject({ status: 'done', accountId: account.id, activated: true });
    expect(seen.completed).toBe(account.id);
    await sessions.stop();
  });

  test('a refused store tells the page the numbers but never writes them to the log', async () => {
    const warn = spyOn(log, 'warn');
    let hooks: DriverHooks | null = null;
    const sessions = new AttachSessions({
      authorize: () => Promise.resolve(),
      start: (_station, _input, h) => {
        hooks = h;
        return Promise.resolve({ prompt: { step: 'scan', prompt: 'scan' }, driver: { submit: () => Promise.resolve(), cancel: () => Promise.resolve() } });
      },
      complete: () => Promise.reject(new ApiError('This channel is 447700900123, not 447700900999. Nothing was changed.', 400)),
    });
    const started = await sessions.start(OWNER, 'whatsapp', {}, account.id);
    const done = hooks as DriverHooks | null;
    done?.done({ config: { phone: '447700900999' }, identity: {} });
    let view: AttachView = sessions.view(OWNER, started.attachId);
    for (let i = 0; i < 50 && view.status === 'pending'; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
      view = sessions.view(OWNER, started.attachId);
    }
    expect(view).toMatchObject({ status: 'failed', error: 'This channel is 447700900123, not 447700900999. Nothing was changed.' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('4477009');
    warn.mockRestore();
    await sessions.stop();
  });
});
