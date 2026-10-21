import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jidNormalizedUser, makeEventBuffer, type WAMessage } from 'baileys';
import { createHistory, type History } from '../src/history.ts';
import { makeKeyCache } from '../src/keys.ts';
import { idOf, makeNameBook, noteContact, type NameBook } from '../src/names.ts';
import { baileysLogger } from '../src/logger.ts';
import { bindMessages } from '../src/messages.ts';

const SELF = '447700900111@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';
const LID = '183103582650419@lid';
const PN = '41791234567@s.whatsapp.net';

function message(id: string, over: Partial<WAMessage['key']>, name: Partial<Pick<WAMessage, 'pushName' | 'verifiedBizName'>>): WAMessage {
  return {
    key: { id, remoteJid: GROUP, fromMe: false, ...over },
    messageTimestamp: Math.floor(Date.now() / 1000),
    ...name,
    message: { conversation: `fixture ${id}` },
  };
}

describe('every place WhatsApp names a person', () => {
  let dir: string;
  let previous: string | undefined;
  let history: History;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metro-wa-names-'));
    previous = process.env.WHATSAPP_TOKEN_DIR;
    process.env.WHATSAPP_TOKEN_DIR = dir;
    history = createHistory('fixture');
  });

  afterEach(() => {
    history.close();
    if (previous === undefined) delete process.env.WHATSAPP_TOKEN_DIR;
    else process.env.WHATSAPP_TOKEN_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  function bound(): { ev: ReturnType<typeof makeEventBuffer>; names: NameBook } {
    const ev = makeEventBuffer(baileysLogger('fixture'));
    const names = makeNameBook();
    bindMessages({ ev, user: { id: SELF } }, {
      accountId: 'fixture', keys: makeKeyCache(), names, history,
      current: () => true,
      self: () => ({ jids: new Set([SELF]), sentByMe: () => false }),
      handlers: () => ({ onMessage: () => undefined, onReaction: () => undefined }),
    });
    return { ev, names };
  }

  test('a live message names its sender under the lid and the phone number it carries', () => {
    const { ev, names } = bound();
    ev.emit('messages.upsert', { type: 'notify', messages: [message('live', { participant: LID, participantAlt: `41791234567:3@s.whatsapp.net` }, { pushName: 'Jan' })] });
    expect(names.get(LID)).toBe('Jan');
    expect(names.get(PN)).toBe('Jan');
  });

  test('a business that sets no push name is named by its verified name', () => {
    const { ev, names } = bound();
    ev.emit('messages.upsert', { type: 'notify', messages: [message('biz', { remoteJid: PN }, { verifiedBizName: 'Anderra AG' })] });
    expect(names.get(PN)).toBe('Anderra AG');
    ev.emit('contacts.update', [{ id: '41790000000@s.whatsapp.net', verifiedName: 'MCI Group' }]);
    expect(names.get('41790000000@s.whatsapp.net')).toBe('MCI Group');
  });

  test('the first sync after pairing: pushnames, past messages and the lid mappings it carries', () => {
    const { ev, names } = bound();
    ev.emit('messaging-history.set', {
      chats: [],
      contacts: [{ id: '41792222222@s.whatsapp.net', notify: 'Push Name' }],
      messages: [message('past', { participant: '999@lid', participantAlt: '41793333333@s.whatsapp.net' }, { pushName: 'Past Sender' })],
      lidPnMappings: [{ pn: '41792222222@s.whatsapp.net', lid: '222@lid' }],
    });
    expect(names.get('222@lid')).toBe('Push Name');
    expect(names.get('999@lid')).toBe('Past Sender');
    expect(names.get('41793333333@s.whatsapp.net')).toBe('Past Sender');
  });

  test('an address book name from the phone (app state) is kept under the lid and the number', () => {
    const { ev, names } = bound();
    ev.emit('contacts.upsert', [{ id: LID, phoneNumber: PN, name: 'Jan from the address book' }]);
    expect(names.get(LID)).toBe('Jan from the address book');
    expect(names.get(PN)).toBe('Jan from the address book');
  });

  test('a lid mapping learned later carries a name known under the other id', () => {
    const { ev, names } = bound();
    names.note(PN, 'Jan');
    ev.emit('lid-mapping.update', { pn: PN, lid: LID });
    expect(names.get(LID)).toBe('Jan');
    names.note('5@lid', 'Eve');
    noteContact(names, { id: '5@lid', phoneNumber: '41795555555@s.whatsapp.net' });
    expect(names.get('41795555555@s.whatsapp.net')).toBe('Eve');
  });

  test('ids are normalized like Baileys does, without loading Baileys in the station module', () => {
    for (const jid of ['41791234567:12@s.whatsapp.net', '41791234567@c.us', '183103582650419:2@lid', '183103582650419@lid', '120363000000000001@g.us', '41791234567@s.whatsapp.net'])
      expect(idOf(jid)).toBe(jidNormalizedUser(jid));
    expect(idOf('')).toBeUndefined();
    expect(idOf('not a jid')).toBeUndefined();
    expect(idOf(null)).toBeUndefined();
  });

  test('ids with a device part are filed under the person', () => {
    const names = makeNameBook();
    names.note('41791234567:12@s.whatsapp.net', 'Jan');
    expect(names.get(PN)).toBe('Jan');
    expect(names.get('41791234567:3@s.whatsapp.net')).toBe('Jan');
    names.alias('41791234567:5@s.whatsapp.net', '183103582650419:2@lid');
    expect(names.get(LID)).toBe('Jan');
  });

  test('a known name is never overwritten by the copy of another id', () => {
    const names = makeNameBook();
    names.note(PN, 'Jan');
    names.note(LID, 'Jan Muster');
    names.alias(PN, LID);
    expect(names.get(PN)).toBe('Jan');
    expect(names.get(LID)).toBe('Jan Muster');
  });
});
