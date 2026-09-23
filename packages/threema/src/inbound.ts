import type { Account } from './accounts.js';
import { emitInbound } from '@metro-labs/core/stations/train-events';
import {
  DIRECT,
  reactionEnvelope,
  receiptEnvelope,
  textEnvelope,
  type InboundMeta,
  type Room,
} from './format.js';
import { deliverFile } from './files.js';
import type { Decoded, GroupRef } from './messages.js';
import { requestSync, sentByUs } from './outbound.js';

const synced = new Set<string>();

function roomOf(acct: Account, group: GroupRef | null): Room {
  if (group === null) return DIRECT;
  return { group, name: acct.groups.get(group)?.name ?? null };
}

function askForRoster(acct: Account, group: GroupRef): void {
  const key = `${acct.cfg.id}:${group.creator}-${group.groupId}`;
  if (acct.groups.get(group) !== undefined || synced.has(key)) return;
  synced.add(key);
  requestSync(acct, group).catch((err: unknown) => {
    process.stderr.write(`threema[${acct.cfg.id}]: could not ask ${group.creator} for the group roster: ${err instanceof Error ? err.message : String(err)}\n`);
  });
}

function reactions(acct: Account, m: InboundMeta, d: Extract<Decoded, { kind: 'receipt' }>): string {
  let count = 0;
  for (const target of d.messageIds) {
    const env = receiptEnvelope(acct.cfg.id, m, d.status, target, roomOf(acct, d.group));
    if (env === null) continue;
    emitInbound(acct.cfg.id, env);
    count += 1;
  }
  return count > 0 ? 'reaction' : `receipt:${String(d.status)}`;
}

function control(acct: Account, m: InboundMeta, d: Decoded): string | null {
  if (d.kind === 'group-setup') {
    acct.groups.setup(m.from, d.groupId, d.members);
    return 'group-setup';
  }
  if (d.kind === 'group-rename') {
    acct.groups.rename(m.from, d.groupId, d.name);
    return 'group-rename';
  }
  if (d.kind === 'group-leave') {
    acct.groups.leave(d.group, m.from);
    return 'group-leave';
  }
  return null;
}

function chat(acct: Account, m: InboundMeta, d: Decoded): string | null {
  if (d.kind === 'text') {
    emitInbound(acct.cfg.id, textEnvelope(acct.cfg.id, m, d.text, sentByUs));
    return 'text';
  }
  if (d.kind === 'group-text') {
    askForRoster(acct, d.group);
    emitInbound(acct.cfg.id, textEnvelope(acct.cfg.id, m, d.text, sentByUs, roomOf(acct, d.group)));
    return 'group-text';
  }
  if (d.kind === 'file') {
    if (d.group !== null) askForRoster(acct, d.group);
    deliverFile(acct, m, d.file, roomOf(acct, d.group), sentByUs);
    return 'file';
  }
  if (d.kind === 'reaction') {
    if (d.group !== null) askForRoster(acct, d.group);
    emitInbound(acct.cfg.id, reactionEnvelope(acct.cfg.id, m, d.emoji, d.messageId, d.removed, roomOf(acct, d.group)));
    return 'reaction';
  }
  return null;
}

export function deliver(acct: Account, m: InboundMeta, d: Decoded): string {
  const handled = control(acct, m, d) ?? chat(acct, m, d);
  if (handled !== null) return handled;
  if (d.kind === 'receipt') return reactions(acct, m, d);
  if (d.kind === 'typing') return 'typing';
  const type = d.kind === 'other' ? `0x${d.type.toString(16)}` : d.kind;
  process.stderr.write(`threema[${acct.cfg.id}]: ignored a message of type ${type} from ${m.from}\n`);
  return `ignored:${type}`;
}
