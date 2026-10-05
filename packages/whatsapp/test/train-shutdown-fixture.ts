import { mock } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WAMessage } from 'baileys';
import { createClient } from '../src/client.js';
import { createHistory, historyFiles } from '../src/history.js';
import { CHAT, fixtureRuntime } from './client-fixture.js';

const dir = process.env.WHATSAPP_TOKEN_DIR;
if (!dir) throw new Error('Fixture requires isolated token directory');
const actualCreateClient = createClient;
const message: WAMessage = {
  key: { id: 'pending-deletion', remoteJid: CHAT, fromMe: true },
  messageTimestamp: Math.floor(Date.now() / 1000) - 10,
  message: { conversation: 'must not resurrect' },
};
const history = createHistory('fixture');
history.ingest([message]);
history.close();
const f = fixtureRuntime();
f.setEnd(async () => {
  f.ev.emit('messages.upsert', { type: 'append', messages: [message] });
  writeFileSync(join(dir, 'end-started'), readFileSync(historyFiles.path('fixture')));
  while (!existsSync(join(dir, 'release-end'))) await Bun.sleep(10);
  writeFileSync(join(dir, 'end-finished'), 'finished');
});
mock.module('../src/client.js', () => ({
  createClient: (account: Parameters<typeof createClient>[0]) => {
    const client = actualCreateClient(account, f.runtime);
    setTimeout(() => {
      f.ev.emit('connection.update', { connection: 'open' });
      f.ev.emit('messages.delete', { keys: [message.key] });
      writeFileSync(join(dir, 'pending'), JSON.stringify(message));
    }, 0);
    return client;
  },
}));
await import('../src/index.js');
