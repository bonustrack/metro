import { mock } from 'bun:test';
import { strict as assert } from 'node:assert';
import * as appState from '../src/app-state.js';
import { CHAT, SELF, fixture } from './client-fixture.js';
import type { WAClient } from '../src/client.js';

const actualAppState = { ...appState };
mock.module('../src/app-state.js', () => ({ ...actualAppState, supportsHistoryDeletion: () => false }));
const clients: WAClient[] = [];
const f = await fixture(clients);
try {
  assert.equal(await f.client.sendText(CHAT, 'sent without retention'), 'out-1');
  await assert.rejects(async () => f.client.read(CHAT), { code: 'whatsapp_history_unavailable' });
  assert.equal((await f.client.listMembers(CHAT)).members[0]?.id, SELF);
  f.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { id: 'inbound', remoteJid: CHAT, participant: '123@lid' }, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: 'live fixture' } }] });
  assert.equal(f.live.length, 1);
  await f.client.editMessage(CHAT, 'out-1', 'edited without retention');
  await f.client.deleteMessage(CHAT, 'out-1');
  assert.equal(f.sent.length, 3);
} finally {
  await f.client.disconnect();
}
