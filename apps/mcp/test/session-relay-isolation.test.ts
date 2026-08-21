/**
 * Per-session InboundRelay state.
 *
 * `knownLine`, `allowedLines`, `seenEvents` and `pendingPermissions` used to be
 * one instance for the whole daemon. `pendingPermissions` being one set meant
 * agent A's chat reply could answer agent B's tool-approval prompt, and the
 * dedupe key stripped the account segment with nothing else distinguishing the
 * owner, so two agents sitting on the same conversation id with the same
 * station-native messageId suppressed each other's message.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { InboundRelay } from '../src/channels/inbound.ts';
import { dedupeKey } from '../src/channels/dedupe.ts';
import { SessionRegistry } from '../src/mcp/session-registry.ts';
import { setAgentMap } from '../src/db/agent-map.ts';
import type { RequestIdentity } from '../src/mcp/request-identity.ts';

const TONY: RequestIdentity = { kind: 'agent', agentId: 'agent000001' };
const LISA: RequestIdentity = { kind: 'agent', agentId: 'agent000034' };

const TONY_A = 'metro://discord/a1-tony/guild/9/chan/7';
const TONY_B = 'metro://discord/a1-tony2/guild/9/chan/7';
const LISA_A = 'metro://discord/a34-lisa/guild/9/chan/7';

beforeAll(() =>
  setAgentMap(
    {
      'discord/a1-tony': 'agent000001',
      'discord/a1-tony2': 'agent000001',
      'discord/a34-lisa': 'agent000034',
    },
    { ['agent000001']: 'Tony', ['agent000034']: 'Lisa' },
  ),
);
afterAll(() => setAgentMap({}, {}));

interface Notif {
  method: string;
  params: Record<string, unknown>;
}

function makeRelay(): { relay: InboundRelay; notifs: Notif[] } {
  const notifs: Notif[] = [];
  const relay = new InboundRelay({
    mcp: {
      notification: (n: Notif) => {
        notifs.push(n);
        return Promise.resolve();
      },
    } as never,
    log: () => undefined,
    getStations: () => new Set(['discord']),
    senderAllowed: () => true,
  });
  return { relay, notifs };
}

const inbound = (
  line: string,
  text: string,
  messageId: string,
): Record<string, unknown> => ({
  id: `id-${messageId}-${line}`,
  ts: new Date().toISOString(),
  station: 'discord',
  line,
  from: `${line}/sender`,
  to: line,
  text,
  messageId,
  event: { type: 'msg' },
});

describe('inbound dedupe key', () => {
  test('two accounts of ONE agent in one conversation still collapse to one key', () => {
    expect(dedupeKey('discord', TONY_A, 'msg', 'shared-1')).toBe(
      dedupeKey('discord', TONY_B, 'msg', 'shared-1'),
    );
  });

  test('two agents on the same conversation id never share a key', () => {
    expect(dedupeKey('discord', TONY_A, 'msg', 'shared-1')).not.toBe(
      dedupeKey('discord', LISA_A, 'msg', 'shared-1'),
    );
  });

  test('a message and its later reaction stay distinct', () => {
    expect(dedupeKey('discord', TONY_A, 'msg', 'shared-1')).not.toBe(
      dedupeKey('discord', TONY_A, 'react', 'shared-1'),
    );
  });
});

describe('one relay per session', () => {
  test('a duplicate from the same agent second account is still dropped', async () => {
    const { relay, notifs } = makeRelay();
    await relay.handleEvent(inbound(TONY_A, 'hello once', 'dup-1'));
    await relay.handleEvent(inbound(TONY_B, 'hello once', 'dup-1'));
    expect(notifs.map((n) => n.params.content)).toEqual(['hello once']);
  });

  test('another agent identical messageId is never suppressed by mine', async () => {
    const { relay, notifs } = makeRelay();
    await relay.handleEvent(inbound(TONY_A, 'tony copy', 'collide-1'));
    await relay.handleEvent(inbound(LISA_A, 'lisa copy', 'collide-1'));
    expect(notifs.map((n) => n.params.content)).toEqual([
      'tony copy',
      'lisa copy',
    ]);
  });

  test('knownLine is per relay, never carried from another session', async () => {
    const tony = makeRelay();
    const lisa = makeRelay();
    await tony.relay.handleEvent(inbound(TONY_A, 'hi', 'k-1'));
    expect(tony.relay.knownLine).toBe(TONY_A);
    expect(lisa.relay.knownLine).toBeUndefined();
  });

  test('a chat reply cannot answer another session pending permission', async () => {
    const tony = makeRelay();
    const lisa = makeRelay();
    tony.relay.registerPermission('abcde');
    lisa.relay.registerPermission('fghij');

    await tony.relay.handleEvent(inbound(TONY_A, 'yes fghij', 'p-1'));
    expect(
      tony.notifs.filter(
        (n) => n.method === 'notifications/claude/channel/permission',
      ),
    ).toEqual([]);
    expect(tony.notifs.at(-1)?.params.content).toBe('yes fghij');

    await lisa.relay.handleEvent(inbound(LISA_A, 'yes fghij', 'p-2'));
    const answered = lisa.notifs.filter(
      (n) => n.method === 'notifications/claude/channel/permission',
    );
    expect(answered.length).toBe(1);
    expect(answered[0]?.params).toEqual({
      request_id: 'fghij',
      behavior: 'allow',
    });
  });

  test('each session answers only its own prompt', async () => {
    const tony = makeRelay();
    tony.relay.registerPermission('abcde');
    await tony.relay.handleEvent(inbound(TONY_A, 'yes abcde', 'p-3'));
    const answered = tony.notifs.filter(
      (n) => n.method === 'notifications/claude/channel/permission',
    );
    expect(answered.length).toBe(1);
    expect(answered[0]?.params).toEqual({
      request_id: 'abcde',
      behavior: 'allow',
    });
  });
});

let registry: SessionRegistry | undefined;
afterEach(async () => {
  await registry?.closeAll();
  registry = undefined;
});

describe('the registry hands every session its own relay', () => {
  test('two sessions share no relay, owner, event store or transport', async () => {
    registry = new SessionRegistry(() => undefined);
    const tony = await registry.create(TONY);
    const lisa = await registry.create(LISA);
    expect(tony.relay).not.toBe(lisa.relay);
    expect(tony.owner).not.toBe(lisa.owner);
    expect(tony.eventStore).not.toBe(lisa.eventStore);
    expect(tony.transport).not.toBe(lisa.transport);
    expect(tony.server).not.toBe(lisa.server);
    expect(tony.channel).not.toBe(lisa.channel);
  });
});
