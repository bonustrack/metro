#!/usr/bin/env bun
// metro watch: standalone Telegram → log bridge.
//
// Long-polls getUpdates against TELEGRAM_BOT_TOKEN, filters to
// TELEGRAM_CHAT_ID, prints one line per message in the format:
//
//   [<ISO8601 UTC>] <user> <single-line-message>
//
// Newlines inside a message are escaped to literal `\n` so each event
// stays on one line. Voice/audio are transcribed via OpenAI; photos with
// captions emit the caption + `<image: file_id>`; bare photos emit
// `<image: file_id>`; callback-button taps emit `<button: callback_data>`.
//
// CONFLICT NOTE: Telegram only allows one active getUpdates poller per
// bot. If `metro-mcp` is polling on the same TELEGRAM_BOT_TOKEN, every
// getUpdates from watch returns 409 "Conflict: terminated by other
// getUpdates request" and the two pollers thrash. Run watch on a
// separate bot, or stop the MCP server's poller (e.g. by hitting a
// different bot token) while watch is up.
//
// Offset is held in-memory only: on startup we drain the backlog so the
// log only carries fresh messages. SIGINT / SIGTERM exit cleanly.

export {};

import { downloadTelegramFile, tg, transcribe } from "./telegram.ts";

const CHAT_ID_RAW = process.env.TELEGRAM_CHAT_ID;
if (!CHAT_ID_RAW) {
  console.error("metro watch: TELEGRAM_CHAT_ID env var is required");
  process.exit(1);
}
const CHAT_ID = String(CHAT_ID_RAW);

function escapeNewlines(s: string): string {
  return s.replace(/\r?\n/g, "\\n");
}

function userOf(m: any): string {
  const f = m.from;
  if (!f) return "?";
  const parts: string[] = [];
  if (f.first_name) parts.push(f.first_name);
  if (f.last_name) parts.push(f.last_name);
  if (parts.length) return parts.join(" ");
  if (f.username) return "@" + f.username;
  return String(f.id);
}

function emit(date: number, user: string, body: string): void {
  const ts = new Date(date * 1000).toISOString();
  // Bun writes synchronously to a pipe — each `\n`-terminated chunk is a
  // discrete line for downstream `tail -F`.
  process.stdout.write(`[${ts}] ${user} ${escapeNewlines(body)}\n`);
}

async function messageBody(m: any): Promise<string | null> {
  if (m.text) return m.text;

  if (Array.isArray(m.photo) && m.photo.length > 0) {
    const photo = m.photo[m.photo.length - 1];
    const caption = m.caption ? m.caption + " " : "";
    return `${caption}<image: ${photo.file_id}>`;
  }

  if (m.document?.mime_type?.startsWith("image/")) {
    const caption = m.caption ? m.caption + " " : "";
    return `${caption}<image: ${m.document.file_id}>`;
  }

  if (m.voice) {
    try {
      const blob = await downloadTelegramFile(m.voice.file_id);
      return await transcribe(blob, "voice.ogg");
    } catch (err: any) {
      return `<voice: transcription failed: ${err?.message ?? err}>`;
    }
  }

  if (m.audio) {
    try {
      const ext = (m.audio.mime_type ?? "audio/mpeg").split("/")[1] ?? "mp3";
      const blob = await downloadTelegramFile(m.audio.file_id);
      return await transcribe(blob, `audio.${ext}`);
    } catch (err: any) {
      return `<audio: transcription failed: ${err?.message ?? err}>`;
    }
  }

  if (m.caption) return m.caption;
  return null;
}

let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

// Drain backlog so we only log fresh messages.
let offset = 0;
try {
  const initial = await tg<Array<{ update_id: number }>>("getUpdates", { timeout: 0 });
  if (initial.length) offset = initial[initial.length - 1].update_id + 1;
} catch (err: any) {
  console.error(`metro watch: initial drain failed: ${err?.message ?? err}`);
}

console.error(`metro watch: bridging chat ${CHAT_ID} (offset=${offset})`);

let backoffMs = 1000;
const MAX_BACKOFF_MS = 30_000;

while (!stopping) {
  try {
    const updates = await tg<Array<any>>("getUpdates", { offset, timeout: 50 }, 60_000);
    backoffMs = 1000;
    for (const u of updates) {
      offset = u.update_id + 1;

      const cbq = u.callback_query;
      if (cbq) {
        if (String(cbq.message?.chat?.id) !== CHAT_ID) continue;
        const date = cbq.message?.date ?? Math.floor(Date.now() / 1000);
        emit(date, userOf(cbq), `<button: ${cbq.data ?? ""}>`);
        continue;
      }

      const m = u.message;
      if (!m || String(m.chat?.id) !== CHAT_ID) continue;
      const body = await messageBody(m);
      if (body === null) continue;
      emit(m.date ?? Math.floor(Date.now() / 1000), userOf(m), body);
    }
  } catch (err: any) {
    console.error(`metro watch: ${err?.message ?? err} — retrying in ${backoffMs}ms`);
    await new Promise(r => setTimeout(r, backoffMs));
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  }
}
console.error("metro watch: stopping");
process.exit(0);
