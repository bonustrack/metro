import { describe, expect, test } from 'bun:test';
import { CHAT_FILE_MAX, type ChatFile } from '@metro-labs/core/chat';
import { ForbiddenError, HttpError } from '@metro-labs/client/api/client';
import type { TurnView } from '@metro-labs/client/api/chat-turns';
import type { ServerStatus } from '@metro-labs/client/api/servers';
import { addPicked, fileInputOf, filesAllowed, isInlineImage, pairFiles, pickedFile, sizeWords, type PickedFile } from '../src/lib/chat-files.ts';
import { rememberSend } from '../src/lib/chat-sends.ts';
import { replyHolds, TurnWatch, type LiveTurn, type TurnApi } from '../src/lib/chat-turn.ts';
import { holdFiles, previewOf, uploadAll, uploadStateOf, uploadsOf, uploadsRunning } from '../src/lib/chat-uploads.ts';

const pick = (name: string, size: number, type = 'application/pdf', preview: string | null = null): PickedFile =>
  pickedFile({ name, type, size, preview: () => preview, body: () => Promise.resolve(new Blob([name])) });

const sent = (id: string, size: number, name = `${id}.pdf`): ChatFile => ({ id, name, type: 'application/pdf', size });

describe('choosing files for a message', () => {
  test('a message carries 5 files at most, each of at most 20 MB, and the page says why it left one out', () => {
    const six = Array.from({ length: 6 }, (_, i) => pick(`f${String(i)}.pdf`, 10));
    const added = addPicked([], six);
    expect(added.files).toHaveLength(5);
    expect(added.refused).toBe('A message can carry 5 files at most.');
    const big = addPicked(added.files.slice(0, 2), [pick('movie.mov', CHAT_FILE_MAX + 1), pick('ok.pdf', CHAT_FILE_MAX)]);
    expect(big.files.map((f) => f.name)).toEqual(['f0.pdf', 'f1.pdf', 'ok.pdf']);
    expect(big.refused).toBe('movie.mov is larger than 20 MB, the most one file can be.');
    expect(addPicked([], [pick('a.txt', 3)]).refused).toBeNull();
  });

  test('a picked file is named and typed the way metro.box stores it, and only its metadata is posted', () => {
    const file = pickedFile({ name: 'notes/\u0000draft.TXT', type: 'Text/Plain', size: 12, preview: (type) => (type === 'text/plain' ? null : 'x'), body: () => Promise.resolve(new Blob([])) });
    expect(file).toMatchObject({ name: 'notes draft.TXT', type: 'text/plain', size: 12, preview: null });
    expect(pickedFile({ name: '', type: '', size: 0, preview: () => null, body: () => Promise.resolve(new Blob([])) })).toMatchObject({ name: 'file', type: 'application/octet-stream' });
    expect(fileInputOf(file)).toEqual({ name: 'notes draft.TXT', type: 'text/plain', size: 12 });
    expect(pick('a', 1).key).not.toBe(pick('a', 1).key);
  });

  test('only png, jpeg, gif and webp show inline; everything else is a chip', () => {
    for (const type of ['image/png', 'image/jpeg', 'IMAGE/GIF', 'image/webp']) expect(isInlineImage(type)).toBe(true);
    for (const type of ['image/svg+xml', 'image/heic', 'application/pdf', 'text/html', 'application/octet-stream']) expect(isInlineImage(type)).toBe(false);
  });

  test('sizes read in plain units', () => {
    expect(sizeWords(820)).toBe('820 B');
    expect(sizeWords(12_800)).toBe('13 KB');
    expect(sizeWords(3_500_000)).toBe('3.3 MB');
    expect(sizeWords(CHAT_FILE_MAX)).toBe('20 MB');
  });

  test('the files metro.box answers are paired with the picked bytes in order, never by a wrong size', () => {
    const local = [pick('a.pdf', 5), pick('b.pdf', 6)];
    expect(pairFiles([sent('fileAAAAAAA', 5), sent('fileBBBBBBB', 6)], local).map((h) => `${h.file.id}:${h.picked.name}`)).toEqual(['fileAAAAAAA:a.pdf', 'fileBBBBBBB:b.pdf']);
    expect(pairFiles([sent('fileAAAAAAA', 5), sent('fileBBBBBBB', 7)], local).map((h) => h.file.id)).toEqual(['fileAAAAAAA']);
    expect(pairFiles([], local)).toEqual([]);
  });
});

describe('which boxes take files', () => {
  const status = (extra: Partial<ServerStatus>): ServerStatus => ({ state: 'live', version: '0.1.0-beta.343', owner: null, ...extra });

  test('attach shows only for a live box on beta.343 or later; an unknown version never hides it', () => {
    expect(filesAllowed(undefined)).toBe(false);
    expect(filesAllowed(status({}))).toBe(true);
    expect(filesAllowed(status({ version: '0.1.0-beta.350' }))).toBe(true);
    expect(filesAllowed(status({ version: '0.1.0-beta.342' }))).toBe(false);
    expect(filesAllowed(status({ version: null }))).toBe(true);
    expect(filesAllowed(status({ state: 'offline' }))).toBe(false);
    expect(filesAllowed(status({ state: 'updating' }))).toBe(false);
  });
});

describe('uploading the files of a message', () => {
  test('a failed upload keeps the bytes, and the next try sends only the files that did not arrive', async () => {
    const files = [sent('upAAAAAAAAA', 1), sent('upBBBBBBBBB', 1), sent('upCCCCCCCCC', 1)];
    holdFiles('msgUpload01', files.map((file, i) => ({ file, picked: pick(`${String(i)}.pdf`, 1, 'image/png', `blob:${String(i)}`) })));
    expect(previewOf('upAAAAAAAAA')).toBe('blob:0');
    const puts: string[] = [];
    const failing = uploadAll('msgUpload01', files, (file) => {
      puts.push(file.id);
      return file.id === 'upBBBBBBBBB' ? Promise.reject(new Error('Failed to reach Metro.')) : Promise.resolve();
    });
    expect(uploadsRunning('msgUpload01')).toBe(true);
    await expect(failing).rejects.toThrow('Failed to reach Metro.');
    expect(uploadsRunning('msgUpload01')).toBe(false);
    const states = (): (string | null)[] => files.map((f) => uploadStateOf(uploadsOf('msgUpload01'), f.id));
    expect(states()).toEqual(['sent', 'failed', 'waiting']);
    puts.length = 0;
    expect(await uploadAll('msgUpload01', files, (file) => { puts.push(file.id); return Promise.resolve(); })).toEqual({ lost: [] });
    expect(puts).toEqual(['upBBBBBBBBB', 'upCCCCCCCCC']);
    expect(states()).toEqual(['sent', 'sent', 'sent']);
  });

  test('a page that lost the bytes names those files instead of uploading nothing', async () => {
    expect(await uploadAll('msgLost0001', [sent('lostAAAAAAA', 1)], () => Promise.reject(new Error('never')))).toEqual({ lost: ['lostAAAAAAA'] });
  });
});

const view = (extra: Partial<TurnView>): TurnView => ({ seq: 1, delivery: 'saved', events: [], parts: null, done: true, state: 'done', error: null, ...extra });

interface Run {
  shown: LiveTurn[];
  calls: string[];
  done: Promise<void>;
}

function watchWith(api: Partial<TurnApi>, message: string): Run {
  const shown: LiveTurn[] = [];
  const calls: string[] = [];
  const full: TurnApi = {
    send: api.send ?? ((_host, ticket) => { calls.push(`send ${ticket}`); return Promise.resolve('t'); }),
    poll: api.poll ?? (() => Promise.resolve(view({}))),
    stop: () => Promise.resolve(),
    renew: () => Promise.resolve('view'),
    upload: api.upload ?? ((_host, _message, file, ticket) => { calls.push(`put ${file} ${ticket}`); return Promise.resolve(); }),
    resend: api.resend ?? (() => { calls.push('resend'); return Promise.resolve('fresh'); }),
  };
  const watch = new TurnWatch({ api: full, host: 'box.ts.net', chat: 'chat0000001', message, sentAt: Date.now(), ticket: () => 'view', onChange: (turn) => { shown.push(turn); }, onDone: () => undefined, onStopFailed: () => undefined, signal: new AbortController().signal });
  return { shown, calls, done: watch.run() };
}

describe('a message with files reaches the agent', () => {
  test('every file is uploaded with the send ticket before the turn starts, then the bytes are let go', async () => {
    const files = [sent('turnAAAAAAA', 1), sent('turnBBBBBBB', 1)];
    holdFiles('msgTurn0001', files.map((file) => ({ file, picked: pick(file.name, 1) })));
    rememberSend('msgTurn0001', 'send-ticket', '', files);
    const run = watchWith({}, 'msgTurn0001');
    await run.done;
    expect(run.calls).toEqual(['put turnAAAAAAA send-ticket', 'put turnBBBBBBB send-ticket', 'send send-ticket']);
    expect(run.shown.map((s) => s.phase)).toEqual(['uploading', 'starting', 'live', 'done']);
    expect(files.map((f) => uploadStateOf(uploadsOf('msgTurn0001'), f.id))).toEqual(['sent', 'sent']);
    const first = run.shown[0];
    if (first === undefined) throw new Error('nothing shown');
    expect(replyHolds(first)).toBe(true);
  });

  test('a failed upload shows under the message with Try again, which sends only the missing file', async () => {
    const files = [sent('failAAAAAAA', 1), sent('failBBBBBBB', 1)];
    holdFiles('msgFail0001', files.map((file) => ({ file, picked: pick(file.name, 1) })));
    rememberSend('msgFail0001', 'send-ticket', 'look', files);
    const first = watchWith({ upload: (_h, _m, file) => (file === 'failBBBBBBB' ? Promise.reject(new HttpError('Metro returned 500.', 500)) : Promise.resolve()) }, 'msgFail0001');
    await first.done;
    expect(first.shown.at(-1)).toMatchObject({ phase: 'failed', again: 'send', error: 'The files did not reach the agent. Metro returned 500.' });
    rememberSend('msgFail0001', 'retry-ticket', 'look', files);
    const again = watchWith({}, 'msgFail0001');
    await again.done;
    expect(again.calls).toEqual(['put failBBBBBBB retry-ticket', 'send retry-ticket']);
  });

  test('an upload the box refuses because the turn already started is not a failure: the page goes on to watch', async () => {
    const files = [sent('lateAAAAAAA', 1)];
    holdFiles('msgLate0001', files.map((file) => ({ file, picked: pick(file.name, 1) })));
    rememberSend('msgLate0001', 'send-ticket', '', files);
    const run = watchWith({ upload: () => Promise.reject(new HttpError('This message was already sent to the agent.', 409)) }, 'msgLate0001');
    await run.done;
    expect(run.calls).toEqual(['send send-ticket']);
    expect(run.shown.some((s) => s.phase === 'failed')).toBe(false);
  });

  test('an expired send ticket during a long upload is renewed once and the upload goes on', async () => {
    const files = [sent('slowAAAAAAA', 1)];
    holdFiles('msgSlow0001', files.map((file) => ({ file, picked: pick(file.name, 1) })));
    rememberSend('msgSlow0001', 'old-ticket', '', files);
    const tickets: string[] = [];
    const run = watchWith({ upload: (_h, _m, _f, ticket) => { tickets.push(ticket); return ticket === 'old-ticket' ? Promise.reject(new ForbiddenError('expired')) : Promise.resolve(); } }, 'msgSlow0001');
    await run.done;
    expect(tickets).toEqual(['old-ticket', 'fresh']);
    expect(run.calls).toEqual(['resend', 'send fresh']);
  });

  test('after a reload the turn starts with the files the page still has, and the others read Not sent', async () => {
    const kept = sent('keptAAAAAAA', 1);
    const files = [kept, sent('goneAAAAAAA', 1)];
    holdFiles('msgReload01', [{ file: kept, picked: pick('kept.pdf', 1) }]);
    rememberSend('msgReload01', 'send-ticket', '', files);
    const run = watchWith({}, 'msgReload01');
    await run.done;
    expect(run.calls).toEqual(['put keptAAAAAAA send-ticket', 'send send-ticket']);
    expect(run.shown.some((s) => s.phase === 'failed')).toBe(false);
    expect(files.map((f) => uploadStateOf(uploadsOf('msgReload01'), f.id))).toEqual(['sent', 'unsent']);
  });

  test('a 409 on start only means a reply already runs: the page watches it', async () => {
    rememberSend('msgBusy0001', 'send-ticket', 'hi');
    const busy = watchWith({ send: () => Promise.reject(new HttpError('The agent is still answering in this chat. Wait for it, or stop it.', 409)) }, 'msgBusy0001');
    await busy.done;
    expect(busy.shown.some((s) => s.phase === 'failed')).toBe(false);
  });
});
