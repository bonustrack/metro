#!/usr/bin/env bun
// Standalone inbound stream. Polls Telegram + connects to Discord, prints
// one JSON line per inbound message on stdout. Designed to be launched by
// an agent and observed via Claude Code's `Bash run_in_background=true` +
// `Monitor`, or Codex's `unified_exec` + `write_stdin` polling.
//
// Each line shape:
//   {"platform":"telegram","chat_id":"…","message_id":42,"text":"…"}
//   {"platform":"discord","channel_id":"…","message_id":"…","text":"…"}
//
// On every inbound, the server fires a 👀 emoji reaction so the user sees
// immediate acknowledgement on the original platform — no agent involvement.
// Override with METRO_ACK_EMOJI; set to empty string to disable.
//
// stderr carries pino-formatted operational logs; stdout is reserved for
// JSON inbound messages so observers can parse it as JSONL.

import { configuredPlatforms, loadMetroEnv, requireConfiguredPlatform, startPlatforms } from "./config.js";
import * as discord from "./discord.js";
import { log } from "./log.js";
import { tg } from "./telegram.js";

loadMetroEnv();
const platforms = configuredPlatforms();
requireConfiguredPlatform(platforms);

const ACK_EMOJI = process.env.METRO_ACK_EMOJI ?? "👀";

function emit(line: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function ackTelegram(chatId: string | number, messageId: number): void {
  if (!ACK_EMOJI) return;
  void tg("setMessageReaction", {
    chat_id: chatId,
    message_id: messageId,
    reaction: [{ type: "emoji", emoji: ACK_EMOJI }],
  }).catch(err => log.warn({ err: err?.message ?? err }, "telegram auto-react failed"));
}

function ackDiscord(channelId: string, messageId: string): void {
  if (!ACK_EMOJI) return;
  void discord
    .setReaction(channelId, messageId, ACK_EMOJI)
    .catch(err => log.warn({ err: err?.message ?? err }, "discord auto-react failed"));
}

await startPlatforms(platforms, {
  telegram: m => {
    ackTelegram(m.chat_id, m.message_id);
    emit({ platform: "telegram", chat_id: String(m.chat_id), message_id: m.message_id, text: m.text });
  },
  discord: m => {
    ackDiscord(m.channel_id, m.message_id);
    emit({ platform: "discord", channel_id: m.channel_id, message_id: m.message_id, text: m.text });
  },
});

process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
