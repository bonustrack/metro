/**
 * Drives the real inbound path (publishEvent -> bus -> ChannelRelay ->
 * InboundRelay -> notification) with the gate the session uses: a stream must
 * be attached and the line must pass `eventInScope`. A line whose account maps
 * to no agent never arrives; an event with no stream to read it waits in the
 * ring for the next one.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ChannelRelay } from '../src/channels/relay.ts';
import { InboundRelay } from '../src/channels/inbound.ts';
import { eventInScope } from '../src/agents/scope.ts';
import { publishEvent, type MetroEvent } from '@metro-labs/core/events';
import { setAgentMap } from '../src/agents/map.ts';
import { asLine } from '@metro-labs/core/lines';

const TONY = new Set(['agent000001']);
const TONY_LINE = 'metro://whatsapp/a1-tony/111@lid';
const STRAY_LINE = 'metro://whatsapp/a9-stray/222@lid';

beforeEach(() =>
  setAgentMap({ 'whatsapp/a1-tony': 'agent000001' }, { ['agent000001']: 'Tony' }),
);
afterAll(() => setAgentMap({}, {}));

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

function makeSession(stream: { attached: boolean }): {
  received: string[];
  channel: ChannelRelay;
} {
  const received: string[] = [];
  const relay = new InboundRelay({
    mcp: {
      notification: (n: { params: { content?: string } }) => {
        received.push(n.params.content ?? '');
        return Promise.resolve();
      },
    } as never,
    log: () => {},
    getStations: () => new Set(['whatsapp']),
    senderAllowed: () => true,
  });
  return {
    received,
    channel: new ChannelRelay({
      relay,
      log: () => {},
      inScope: (line) => stream.attached && eventInScope(TONY, line),
    }),
  };
}

const inbound = (line: string, text: string): MetroEvent =>
  ({
    id: `id-${randomUUID()}`,
    ts: new Date().toISOString(),
    station: 'whatsapp',
    line: asLine(line),
    from: asLine(`${line}/sender`),
    to: asLine(line),
    text,
    messageId: `m-${randomUUID()}`,
    event: { type: 'msg' },
  }) as unknown as MetroEvent;

describe('inbound delivery is scoped to the agent', () => {
  test('a line whose account maps to no agent never arrives, the agent own line does', async () => {
    const stream = { attached: true };
    const { received, channel } = makeSession(stream);
    const stop = channel.start();

    publishEvent(inbound(STRAY_LINE, 'stray'));
    publishEvent(inbound(TONY_LINE, 'hello tony'));
    await settle();
    channel.replayMissed();
    await settle();
    stop();

    expect(received).toEqual(['hello tony']);
  });

  test('with no stream an event is withheld, then replayed once one attaches', async () => {
    const stream = { attached: false };
    const { received, channel } = makeSession(stream);
    const stop = channel.start();

    publishEvent(inbound(TONY_LINE, 'held for tony'));
    await settle();
    expect(received).toEqual([]);

    stream.attached = true;
    channel.replayMissed();
    await settle();
    stop();

    expect(received).toEqual(['held for tony']);
  });
});
