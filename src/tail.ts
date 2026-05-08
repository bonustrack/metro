#!/usr/bin/env bun
// Standalone inbound stream. Polls Telegram + connects to Discord, prints
// one JSON line per inbound message on stdout. Designed to be launched by
// an agent and observed via Bash+Monitor (Claude Code) or unified_exec
// polling (Codex).
//
// On every inbound: fires the METRO_ACK_EMOJI reaction (default 👀) and
// starts a typing indicator that refreshes until the agent replies (signaled
// by server.ts touching .typing-stop/<key>) or the 60s safety cap is hit.

import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import * as discord from './channels/discord.js';
import * as telegram from './channels/telegram.js';
import { tg } from './channels/telegram.js';
import { configuredPlatforms, loadMetroEnv, REPO_ROOT, requireConfiguredPlatform } from './config.js';
import { errMsg, log } from './log.js';

loadMetroEnv();
const platforms = configuredPlatforms();
requireConfiguredPlatform(platforms);

const ACK = process.env.METRO_ACK_EMOJI ?? '👀';
const TYPING_DIR = join(REPO_ROOT, '.typing-stop');
const TYPING_REFRESH_MS = 4_000;
const TYPING_MAX_MS = 60_000;

mkdirSync(TYPING_DIR, { recursive: true });

const emit = (line: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(line)}\n`);

type Platform = 'telegram' | 'discord';
const typingActive = new Map<string, number>();
const typingKey = (platform: Platform, chat: string) => `${platform}_${chat}`;

function fireTyping(platform: Platform, chat: string): void {
  if (platform === 'telegram') {
    void tg('sendChatAction', { chat_id: chat, action: 'typing' }).catch(err =>
      log.warn({ err: errMsg(err) }, 'telegram typing failed'),
    );
  } else {
    void discord.sendTyping(chat).catch(err => log.warn({ err: errMsg(err) }, 'discord typing failed'));
  }
}

function startTyping(platform: Platform, chat: string): void {
  const k = typingKey(platform, chat);
  typingActive.set(k, Date.now());
  // Clear any stale stop signal so the new typing actually fires.
  const stopFile = join(TYPING_DIR, k);
  if (existsSync(stopFile)) {
    try { unlinkSync(stopFile); } catch { /* benign race */ }
  }
  fireTyping(platform, chat);
}

setInterval(() => {
  const now = Date.now();
  for (const [k, started] of typingActive) {
    const stopFile = join(TYPING_DIR, k);
    if (existsSync(stopFile)) {
      try { unlinkSync(stopFile); } catch { /* benign race */ }
      typingActive.delete(k);
      continue;
    }
    if (now - started > TYPING_MAX_MS) {
      typingActive.delete(k);
      continue;
    }
    const sep = k.indexOf('_');
    const platform = k.slice(0, sep) as Platform;
    const chat = k.slice(sep + 1);
    fireTyping(platform, chat);
  }
}, TYPING_REFRESH_MS);

if (platforms.telegram) {
  const me = await telegram.getMe();
  log.info({ bot: `@${me.username}` }, 'telegram ready');
  telegram.onInbound(m => {
    if (ACK) {
      void tg('setMessageReaction', {
        chat_id: m.chat_id,
        message_id: m.message_id,
        reaction: [{ type: 'emoji', emoji: ACK }],
      }).catch(err => log.warn({ err: errMsg(err) }, 'telegram auto-react failed'));
    }
    startTyping('telegram', String(m.chat_id));
    emit({ platform: 'telegram', chat_id: String(m.chat_id), message_id: m.message_id, text: m.text });
  });
  void telegram.startPolling();
}

if (platforms.discord) {
  await discord.startGateway();
  const me = await discord.getMe();
  log.info({ bot: me.username }, 'discord ready');
  discord.onInbound(m => {
    if (ACK) {
      void discord
        .setReaction(m.channel_id, m.message_id, ACK)
        .catch(err => log.warn({ err: errMsg(err) }, 'discord auto-react failed'));
    }
    startTyping('discord', m.channel_id);
    emit({ platform: 'discord', channel_id: m.channel_id, message_id: m.message_id, text: m.text });
  });
}

process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
