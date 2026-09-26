import { afterEach, describe, expect, test } from 'bun:test';
import { bufferedSince, currentBusSeq, subscribeEvents, type MetroEvent } from '@metro-labs/core/events';
import { Line } from '@metro-labs/core/lines';
import { makeDedupSeq, makeEmit } from '../src/routes/http.ts';
import { setAgentMap, setDisabledAccounts } from '../src/agents/map.ts';

const message = (account: string, id: string): MetroEvent => ({
  id,
  ts: '2026-09-26T19:00:00.000Z',
  station: 'telegram',
  line: `metro://telegram/${account}/chat/1` as Line,
  from: `metro://telegram/${account}/user/9` as Line,
  to: `metro://telegram/${account}/chat/1` as Line,
  text: 'hello',
  messageId: id,
});

function published(run: () => void): string[] {
  const seen: string[] = [];
  const stop = subscribeEvents((event) => {
    seen.push(event.id);
  });
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (): boolean => true;
  try {
    run();
  } finally {
    process.stdout.write = write;
    stop();
  }
  return seen;
}

afterEach(() => {
  setDisabledAccounts(new Set());
});

describe('Receive messages off stops inbound for that account only', () => {
  test('a message on an account that does not receive never reaches the bus, the other account still does', () => {
    setAgentMap({ 'telegram/off1': 'agent000001', 'telegram/on1': 'agent000001' }, { agent000001: 'Emma' });
    setDisabledAccounts(new Set(['telegram/off1']));
    const emit = makeEmit(makeDedupSeq());
    const before = currentBusSeq();
    const seen = published(() => {
      emit(message('off1', 'msg_off'));
      emit(message('on1', 'msg_on'));
    });
    expect(seen).toEqual(['msg_on']);
    expect(bufferedSince(before).map((b) => b.event.id)).toEqual(['msg_on']);
  });

  test('switching it back on delivers new messages, and nothing written while off comes back', () => {
    setAgentMap({ 'telegram/off1': 'agent000001' }, { agent000001: 'Emma' });
    setDisabledAccounts(new Set(['telegram/off1']));
    const emit = makeEmit(makeDedupSeq());
    const before = currentBusSeq();
    const seen = published(() => {
      emit(message('off1', 'msg_while_off'));
      setDisabledAccounts(new Set());
      emit(message('off1', 'msg_after'));
    });
    expect(seen).toEqual(['msg_after']);
    expect(bufferedSince(before).map((b) => b.event.id)).toEqual(['msg_after']);
  });
});
