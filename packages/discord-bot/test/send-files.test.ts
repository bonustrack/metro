import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendFiles, outgoingFiles } from '../src/send-files.ts';

const dir = mkdtempSync(join(tmpdir(), 'metro-discord-bot-'));
const mp3 = join(dir, 'msg_out0xxdejy0x4_0.mp3');
const png = join(dir, 'msg_out40n8jisx2e_0.png');
writeFileSync(mp3, 'a');
writeFileSync(png, 'b');

const namesOf = (form: FormData): string[] =>
  [...form.values()]
    .filter((v): v is File => typeof v !== 'string')
    .map((f) => f.name);

describe('outgoingFiles', () => {
  test('uses the attachment name so a url-sourced file keeps its real filename', () => {
    const out = outgoingFiles([{ path: mp3, name: 'horse.mp3', kind: 'audio' }]);
    expect(out).toEqual([{ path: mp3, name: 'horse.mp3', kind: 'audio' }]);
  });

  test('falls back to the basename when no name was carried', () => {
    const out = outgoingFiles([{ path: mp3 }]);
    expect(out[0]?.name).toBe('msg_out0xxdejy0x4_0.mp3');
    expect(out[0]?.kind).toBe('file');
  });

  test('an empty name is a fallback, not a filename', () => {
    const out = outgoingFiles([{ path: mp3, name: '', kind: 'audio' }]);
    expect(out[0]?.name).toBe('msg_out0xxdejy0x4_0.mp3');
  });

  test('an attachment with no path is dropped rather than sent as an empty file', () => {
    const out = outgoingFiles([
      { path: mp3, name: 'horse.mp3', kind: 'audio' },
      { name: 'ghost.png', kind: 'image' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('audio');
  });

  test('anything but a list is no files', () => {
    expect(outgoingFiles(undefined)).toEqual([]);
  });
});

describe('appendFiles', () => {
  test('reports one label per file it actually appended', async () => {
    const form = new FormData();
    const delivered = await appendFiles(
      form,
      outgoingFiles([
        { path: mp3, name: 'horse.mp3', kind: 'audio' },
        { path: png, name: 'chart.png', kind: 'image' },
      ]),
    );
    expect(delivered).toEqual(['audio', 'image']);
    expect(namesOf(form)).toEqual(['horse.mp3', 'chart.png']);
  });

  test('a dropped file is neither appended nor labelled', async () => {
    const form = new FormData();
    const delivered = await appendFiles(
      form,
      outgoingFiles([
        { path: mp3, name: 'horse.mp3', kind: 'audio' },
        { path: '', name: 'ghost.png', kind: 'image' },
      ]),
    );
    expect(delivered).toEqual(['audio']);
    expect(namesOf(form)).toEqual(['horse.mp3']);
  });
});
