import {
  EndBehaviorType,
  type VoiceConnection,
  type VoiceReceiver,
} from '@discordjs/voice';
import type { Client } from 'discord.js';
import { spawn } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import prism from 'prism-media';
import { emitInbound } from './format.js';
import { mintId } from './wire.js';

const WHISPER_BIN = process.env.WHISPER_CLI ?? 'whisper-cli';
const WHISPER_MODEL =
  process.env.WHISPER_MODEL ??
  join(process.env.HOME ?? '', '.whisper-models', 'ggml-base.en.bin');
const FFMPEG_BIN = process.env.FFMPEG_BIN ?? 'ffmpeg';
const MIN_PCM_BYTES = 0.5 * 48000 * 2 * 2;

interface Session {
  receiver: VoiceReceiver;
  accountId: string;
  guildId: string;
  channelId: string;
  client: Client;
  active: Set<string>;
  tmp: string;
  enabled: boolean;
  onStart?: (userId: string) => void;
}

const sessions = new Map<string, Session>();

function run(bin: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    p.on('error', reject);
    p.on('close', (code) => {
      resolve(code ?? 0);
    });
  });
}

async function captureUtterance(
  s: Session,
  userId: string,
  pcmPath: string,
): Promise<number> {
  const opus = s.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
  });
  const decoder = new prism.opus.Decoder({
    rate: 48000,
    channels: 2,
    frameSize: 960,
  });
  let bytes = 0;
  decoder.on('data', (c: Buffer) => {
    bytes += c.length;
  });
  const out = createWriteStream(pcmPath);
  await pipeline(opus, decoder, out);
  return bytes;
}

async function pcmToWav(pcmPath: string, wavPath: string): Promise<void> {
  await run(FFMPEG_BIN, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    's16le',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-i',
    pcmPath,
    '-ar',
    '16000',
    '-ac',
    '1',
    wavPath,
  ]);
}

function transcribe(wavPath: string): Promise<string> {
  const ofBase = wavPath.replace(/\.wav$/, '');
  return new Promise((resolve) => {
    const p = spawn(
      WHISPER_BIN,
      [
        '-m',
        WHISPER_MODEL,
        '-f',
        wavPath,
        '-otxt',
        '-of',
        ofBase,
        '-np',
        '-nt',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let out = '';
    p.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    p.on('error', () => {
      resolve('');
    });
    p.on('close', () => {
      let text = out.trim();
      if (!text && existsSync(`${ofBase}.txt`)) {
        try {
          text = readFileSync(`${ofBase}.txt`, 'utf8').trim();
        } catch {
        }
      }
      resolve(text);
    });
  });
}

const NOISE = new Set([
  '',
  '[blank_audio]',
  '[silence]',
  '[ Silence ]',
  '(silence)',
  'you',
  'Thank you.',
]);

async function handleSpeaker(s: Session, userId: string): Promise<void> {
  if (!s.enabled || s.active.has(userId)) return;
  s.active.add(userId);
  const stamp = `${userId}_${Date.now()}`;
  const pcmPath = join(s.tmp, `${stamp}.pcm`);
  const wavPath = join(s.tmp, `${stamp}.wav`);
  try {
    const bytes = await captureUtterance(s, userId, pcmPath);
    if (bytes < MIN_PCM_BYTES) return;
    await pcmToWav(pcmPath, wavPath);
    const text = await transcribe(wavPath);
    if (NOISE.has(text) || text.length < 2) return;
    const member = s.client.guilds.cache
      .get(s.guildId)
      ?.members.cache.get(userId);
    const name = member?.displayName ?? member?.user.username ?? userId;
    emitInbound(s.accountId, {
      kind: 'inbound',
      id: mintId(),
      ts: new Date().toISOString(),
      station: 'discord',
      line: `metro://discord/${s.accountId}/voice/${s.channelId}`,
      line_name: 'voice',
      from: `metro://discord/${s.accountId}/user/${userId}`,
      from_name: name,
      message_id: stamp,
      text,
      is_private: false,
      payload: {
        kind: 'voice_transcript',
        channel_id: s.channelId,
        user_id: userId,
      },
    });
  } catch (err) {
    process.stderr.write(
      `discord voice transcribe error (${userId}): ${(err as Error).message}\n`,
    );
  } finally {
    s.active.delete(userId);
    for (const f of [
      pcmPath,
      wavPath,
      `${wavPath.replace(/\.wav$/, '')}.txt`,
    ]) {
      try {
        rmSync(f, { force: true });
      } catch {
      }
    }
  }
}

export function startTranscription(
  guildId: string,
  channelId: string,
  accountId: string,
  client: Client,
  conn: VoiceConnection,
): void {
  stopTranscription(guildId);
  const receiver = conn.receiver;
  const s: Session = {
    receiver,
    accountId,
    guildId,
    channelId,
    client,
    active: new Set(),
    tmp: mkdtempSync(join(tmpdir(), 'metro-voice-')),
    enabled: true,
  };
  s.onStart = (userId: string) => {
    void handleSpeaker(s, userId);
  };
  receiver.speaking.on('start', s.onStart);
  sessions.set(guildId, s);
  process.stderr.write(
    `discord[${accountId}] voice transcription armed on ${channelId}\n`,
  );
}

export function setTranscription(guildId: string, on: boolean): boolean {
  const s = sessions.get(guildId);
  if (!s) return false;
  s.enabled = on;
  return true;
}

export function stopTranscription(guildId: string): void {
  const s = sessions.get(guildId);
  if (!s) return;
  try {
    if (s.onStart) s.receiver.speaking.removeListener('start', s.onStart);
  } catch {
  }
  s.enabled = false;
  try {
    rmSync(s.tmp, { recursive: true, force: true });
  } catch {
  }
  sessions.delete(guildId);
}
