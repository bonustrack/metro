/** CLI action handlers: raw platform requests + cross-agent notify + helpers. */

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { errMsg } from '../log.js';
import { DiscordStation } from '../stations/discord.js';
import { TelegramStation } from '../stations/telegram.js';
import { ipcCall } from '../ipc.js';
import { agentSelf, appendHistory, mintId, resolvePlatformId } from '../history.js';
import { asLine, Line, type ChatStation, type Line as LineT } from '../stations/index.js';
import { loadMetroEnv } from '../paths.js';
import { emit, flagOne, isJson, need, resolveText, writeJson, type Flags } from './util.js';

type AnyChat = ChatStation<Record<string, unknown>>;

export function chatStationOf(line: LineT): AnyChat {
  const s = Line.station(line);
  if (s === 'discord') return new DiscordStation() as unknown as AnyChat;
  if (s === 'telegram') return new TelegramStation() as unknown as AnyChat;
  throw new Error(`no chat station for line "${line}" (try metro://{discord|telegram}/...)`);
}

const DISCORD_BASE = 'https://discord.com/api/v10';
const TELEGRAM_BASE = 'https://api.telegram.org';

interface RawResult {
  status: number;
  ok: boolean;
  body: unknown;
}

async function rawDiscord(method: string, path: string, body?: unknown): Promise<RawResult> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error('DISCORD_BOT_TOKEN is not set (try `metro setup discord <token>`)');
  const url = `${DISCORD_BASE}${path.startsWith('/') ? path : '/' + path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bot ${token}`,
      'User-Agent': 'metro (https://github.com/bonustrack/metro, dev)',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  const parsed = text ? safeJson(text) : null;
  return { status: res.status, ok: res.ok, body: parsed };
}

async function rawTelegram(method: string, path: string, body?: unknown): Promise<RawResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set (try `metro setup telegram <token>`)');
  /** Telegram is POST-by-default with JSON body; method here just affects whether we send a body. */
  const url = `${TELEGRAM_BASE}/bot${token}${path.startsWith('/') ? path : '/' + path}`;
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  const parsed = text ? safeJson(text) : null;
  return { status: res.status, ok: res.ok, body: parsed };
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export async function cmdRaw(p: string[], f: Flags): Promise<void> {
  need(
    p, 3,
    'metro raw <station> <method> <path> [--body=<json>]\n' +
    '  station: discord | telegram\n' +
    '  example: metro raw discord POST /channels/123/messages --body=\'{"content":"hi"}\'\n' +
    '  example: metro raw telegram POST /sendMessage --body=\'{"chat_id":456,"text":"hi"}\'',
  );
  loadMetroEnv();
  const [station, methodRaw, path] = p;
  const method = methodRaw.toUpperCase();
  if (station !== 'discord' && station !== 'telegram') {
    throw new Error(`unknown station "${station}" (expected: discord, telegram)`);
  }
  const bodyRaw = await resolveBody(f);
  const body = bodyRaw !== undefined ? parseBody(bodyRaw) : undefined;
  const result = station === 'discord'
    ? await rawDiscord(method, path, body)
    : await rawTelegram(method, path, body);

  if (WRITE_METHODS.has(method)) {
    appendHistory({
      id: mintId(), ts: new Date().toISOString(),
      station, kind: 'outbound',
      line: asLine(`metro://${station}/raw`),
      from: agentSelf(),
      to: asLine(`metro://${station}/raw`),
      text: `${method} ${path}`,
    });
  }

  if (isJson(f)) return writeJson(result);
  process.stdout.write(`${result.status} ${result.ok ? 'OK' : 'ERR'}\n`);
  if (result.body !== null) process.stdout.write(JSON.stringify(result.body, null, 2) + '\n');
}

async function resolveBody(f: Flags): Promise<string | undefined> {
  const inline = flagOne(f, 'body');
  if (inline !== undefined) return inline;
  if (process.stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const stdin = Buffer.concat(chunks).toString('utf8').trim();
  return stdin || undefined;
}

function parseBody(raw: string): unknown {
  try { return JSON.parse(raw); }
  catch (err) { throw new Error(`--body must be valid JSON: ${errMsg(err)}`); }
}

export async function cmdNotify(p: string[], f: Flags): Promise<void> {
  need(p, 1, 'metro notify <agent-line> <text>\n  example: metro notify metro://claude/deploys "build green"');
  loadMetroEnv();
  const line = asLine(p[0]);
  if (!Line.isAgent(line)) throw new Error(`notify only targets agent lines (metro://claude/* or metro://codex/*); got "${line}"`);
  const text = await resolveText(p, 1);
  const from = flagOne(f, 'from');
  const resp = await ipcCall({ op: 'notify', line, from, text });
  if (!resp.ok) throw new Error(resp.error);
  emit(f, `notified ${line}`, { ok: true, line });
}

export async function cmdDownload(p: string[], f: Flags): Promise<void> {
  need(p, 2, 'metro download <line> <message_id> [--out=<dir>]'); loadMetroEnv();
  const [to, msgArg] = p, line = asLine(to);
  const messageId = resolvePlatformId(msgArg);
  const outDir = typeof f.out === 'string' ? f.out : join(tmpdir(), 'metro-downloads');
  mkdirSync(outDir, { recursive: true });
  /** Telegram has no get-message-by-id REST endpoint — daemon holds the in-memory snapshot. */
  let files: { path: string; mediaType: string }[];
  if (Line.station(line) === 'telegram') {
    const resp = await ipcCall({ op: 'download', line, messageId, outDir });
    if (!resp.ok) throw new Error(resp.error);
    files = 'files' in resp ? resp.files : [];
  } else {
    files = await chatStationOf(line).download(line, messageId, outDir);
  }
  if (isJson(f)) return writeJson({ ok: true, line, files });
  if (!files.length) process.stdout.write(`(no image attachments on ${line}#${messageId})\n`);
  for (const file of files) process.stdout.write(file.path + '\n');
}

export async function cmdFetch(p: string[], f: Flags): Promise<void> {
  need(p, 1, 'metro fetch <line> [--limit=N]'); loadMetroEnv();
  const line = asLine(p[0]);
  const messages = await chatStationOf(line).fetch(line, Number(flagOne(f, 'limit')) || 20);
  if (isJson(f)) return writeJson({ ok: true, line, messages });
  if (!messages.length) process.stdout.write(`(no messages on ${line})\n`);
  for (const m of messages) process.stdout.write(`${m.timestamp}  ${m.author}: ${m.text}\n`);
}
