import { mintId, SELF_URI } from './wire.js';

type EmitInbound = (accountId: string, e: Record<string, unknown>) => void;

const WHISPER_BIN = process.env.METRO_WHISPER_BIN ?? 'whisper-cli';
const WHISPER_MODEL =
  process.env.METRO_WHISPER_MODEL ??
  `${process.env.HOME}/.cache/whisper-cpp/ggml-base.bin`;
const FFMPEG_BIN = process.env.METRO_FFMPEG_BIN ?? 'ffmpeg';

export async function transcribeAndEmit(
  audio: Uint8Array,
  line: string,
  accountId: string,
  sourceMsgId: string,
  emitInbound: EmitInbound,
): Promise<void> {
  const {
    existsSync: ex,
    readFileSync: rf,
    writeFileSync: wf,
    unlinkSync,
    mkdtempSync,
  } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const j = (...parts: string[]): string => path.join(...parts);
  const { spawn } = await import('node:child_process');
  if (!ex(WHISPER_MODEL)) return;
  const dir = mkdtempSync(j(tmpdir(), 'xmtp-tx-'));
  const inFile = j(dir, 'in.m4a');
  const wav = j(dir, 'in.wav');
  const out = j(dir, 'in');
  const run = (bin: string, args: string[]): Promise<void> =>
    new Promise((res, rej) => {
      const p = spawn(bin, args, { stdio: 'ignore' });
      p.on('error', rej);
      p.on('exit', (c) => {
        if (c === 0) res();
        else rej(new Error(`${bin} ${String(c)}`));
      });
    });
  try {
    wf(inFile, audio);
    await run(FFMPEG_BIN, [
      '-y',
      '-i',
      inFile,
      '-ar',
      '16000',
      '-ac',
      '1',
      wav,
    ]);
    await run(WHISPER_BIN, [
      '-m',
      WHISPER_MODEL,
      '-f',
      wav,
      '--output-txt',
      '-of',
      out,
    ]);
    const text = rf(`${out}.txt`, 'utf8').trim();
    if (!text) return;
    emitInbound(accountId, {
      id: mintId(),
      ts: new Date().toISOString(),
      station: 'xmtp',
      line,
      from: SELF_URI,
      text: `🎙️ ${text}`,
      payload: {
        contentType: 'transcript',
        transcribeFor: sourceMsgId,
        transcript: text,
      },
    });
  } catch (err) {
    process.stderr.write(`xmtp transcribe failed: ${(err as Error).message}\n`);
  } finally {
    for (const f of [inFile, wav, `${out}.txt`]) {
      try {
        unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
  }
}
