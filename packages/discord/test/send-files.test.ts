import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendFiles, outgoingFiles } from '../src/send-files.ts';

const dir = mkdtempSync(join(tmpdir(), 'metro-discord-'));
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
    const out = outgoingFiles([mp3], ['horse.mp3'], ['audio']);
    expect(out).toEqual([{ path: mp3, name: 'horse.mp3', kind: 'audio' }]);
  });

  test('falls back to the basename when no name was carried', () => {
    const out = outgoingFiles([mp3], undefined, undefined);
    expect(out[0]?.name).toBe('msg_out0xxdejy0x4_0.mp3');
  });

  test('an empty name is a fallback, not a filename', () => {
    const out = outgoingFiles([mp3], [''], ['audio']);
    expect(out[0]?.name).toBe('msg_out0xxdejy0x4_0.mp3');
  });

  test('a hole in the path list is dropped rather than sent as an empty file', () => {
    const out = outgoingFiles([mp3, ''], ['horse.mp3', 'ghost.png'], ['audio', 'image']);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('audio');
  });
});

describe('appendFiles', () => {
  test('reports one label per file it actually appended', async () => {
    const form = new FormData();
    const delivered = await appendFiles(
      form,
      outgoingFiles([mp3, png], ['horse.mp3', 'chart.png'], ['audio', 'image']),
    );
    expect(delivered).toEqual(['audio', 'image']);
    expect(namesOf(form)).toEqual(['horse.mp3', 'chart.png']);
  });

  test('a dropped file is neither appended nor labelled', async () => {
    const form = new FormData();
    const delivered = await appendFiles(
      form,
      outgoingFiles([mp3, ''], ['horse.mp3', 'ghost.png'], ['audio', 'image']),
    );
    expect(delivered).toEqual(['audio']);
    expect(namesOf(form)).toEqual(['horse.mp3']);
  });
});
