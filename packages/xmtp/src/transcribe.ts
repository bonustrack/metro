import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { errMsg } from '@metro-labs/core/log';
import { emitInbound, selfUri } from '@metro-labs/core/stations/train-events';
import { mintId } from '@metro-labs/core/stations/station-runtime';

const WHISPER_BIN = process.env.METRO_WHISPER_BIN ?? 'whisper-cli';
const WHISPER_MODEL =
  process.env.METRO_WHISPER_MODEL ??
  `${process.env.HOME}/.cache/whisper-cpp/ggml-base.bin`;
const FFMPEG_BIN = process.env.METRO_FFMPEG_BIN ?? 'ffmpeg';

const run = (bin: string, args: string[]): Promise<void> =>
  new Promise((res, rej) => {
    const p = spawn(bin, args, { stdio: 'ignore' });
    p.on('error', rej);
    p.on('exit', (c) => {
      if (c === 0) res();
      else rej(new Error(`${bin} ${String(c)}`));
    });
  });

export async function transcribeAndEmit(
  audio: Uint8Array,
  line: string,
  accountId: string,
  sourceMsgId: string,
): Promise<void> {
  if (!existsSync(WHISPER_MODEL)) return;
  const dir = mkdtempSync(join(tmpdir(), 'xmtp-tx-'));
  const inFile = join(dir, 'in.m4a');
  const wav = join(dir, 'in.wav');
  const out = join(dir, 'in');
  try {
    writeFileSync(inFile, audio);
    await run(FFMPEG_BIN, ['-y', '-i', inFile, '-ar', '16000', '-ac', '1', wav]);
    await run(WHISPER_BIN, ['-m', WHISPER_MODEL, '-f', wav, '--output-txt', '-of', out]);
    const text = readFileSync(`${out}.txt`, 'utf8').trim();
    if (!text) return;
    emitInbound(accountId, {
      id: mintId(),
      ts: new Date().toISOString(),
      station: 'xmtp',
      line,
      from: selfUri(),
      text: `🎙️ ${text}`,
      payload: {
        contentType: 'transcript',
        transcribeFor: sourceMsgId,
        transcript: text,
      },
    });
  } catch (err) {
    process.stderr.write(`xmtp transcribe failed: ${errMsg(err)}\n`);
  } finally {
    for (const f of [inFile, wav, `${out}.txt`]) {
      try {
        unlinkSync(f);
      } catch {
      }
    }
  }
}
