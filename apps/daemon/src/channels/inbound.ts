import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { str } from '@metro-labs/core/str';
import {
  buildMediaFailureNote,
  buildMediaNote,
  type MediaNote,
  type SavedMedia,
} from './media-note.js';
import { buildWebhookNote } from './webhook-note.js';
import { replyMeta } from './addressed.js';
import {
  capSet,
  displayNameMeta,
  senderMeta,
  tsMeta,
  takeMediaCtx,
  type MediaCtx,
  type PendingAtt,
  type PendingMsg,
} from './pending.js';
import { agentUser } from '../agent-user/user.js';

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

const accountStrippedLine = (line: string): string => {
  const parts = line.split('/');
  if (parts.length < 5) return line;
  return [parts[0], parts[1], parts[2], ...parts.slice(4)].join('/');
};

const dedupeKey = (station: string, line: string, kind: string, messageId: string): string =>
  `${station} ${accountStrippedLine(line)} ${kind} ${messageId}`;

const shortId = (id: string): string => (id.length > 10 ? `${id.slice(0, 6)}…` : id);

function reactionEmoji(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  const obj = raw as { name?: string; reaction?: string } | undefined;
  return obj?.name ?? obj?.reaction ?? '';
}

function reactContent(emoji: string, target: string, removed: boolean): string {
  const verb = removed ? 'removed from' : 'reacted to';
  const label = removed ? emoji || 'reaction' : emoji || 'reacted';
  return `${label} ${verb} message ${shortId(target)}`.trim();
}

interface InboundDeps {
  mcp: Server;
  log: (...a: unknown[]) => void;
  getStations: () => Set<string>;
  senderAllowed: (from: string, line: string, verified?: boolean) => boolean;
  approves?: (station: string) => boolean;
  answerPermission?: (requestId: string, behavior: 'allow' | 'deny', line: string, from: string) => Promise<boolean>;
}

const ATTACH_TIMEOUT_MS = 15_000;
const DEDUPE_TTL_MS = 30_000;
const DEDUPE_MAX = 2_000;
const ALLOWED_LINES_MAX = 2_000;
const SENT_IDS_MAX = 2_000;

export class InboundRelay {
  private readonly deps: InboundDeps;
  private readonly pendingAttachments = new Map<string, PendingMsg>();
  private readonly seenEvents = new Map<string, number>();
  private readonly allowedLines = new Set<string>();
  private readonly sentIds = new Set<string>();
  private lastLine: string | undefined;

  constructor(deps: InboundDeps) {
    this.deps = deps;
  }

  get knownLine(): string | undefined {
    return this.lastLine;
  }

  noteSent(messageId: string): void {
    if (!messageId) return;
    this.sentIds.add(messageId);
    capSet(this.sentIds, SENT_IDS_MAX);
  }

  private notify(method: string, params: Record<string, unknown>): Promise<void> {
    return this.deps.mcp.notification({ method, params });
  }

  private isDuplicate(
    station: string,
    line: string,
    kind: string,
    messageId: string,
  ): boolean {
    if (!messageId) return false;
    const key = dedupeKey(station, line, kind, messageId);
    const now = Date.now();
    if (this.seenEvents.size >= DEDUPE_MAX) {
      for (const [k, t] of this.seenEvents) {
        if (now - t > DEDUPE_TTL_MS) this.seenEvents.delete(k);
      }
    }
    const prev = this.seenEvents.get(key);
    if (prev !== undefined && now - prev < DEDUPE_TTL_MS) return true;
    this.seenEvents.set(key, now);
    return false;
  }

  private surfaceNote(
    ctx: MediaCtx,
    p: SavedMedia,
    note: MediaNote,
    extra: Record<string, unknown>,
  ): Promise<void> {
    return this.notify('notifications/claude/channel', {
      content: note.content,
      meta: {
        line: ctx.line,
        from: ctx.from,
        station: ctx.station,
        ...senderMeta(ctx),
        ...ctx.reply,
        kind: note.kind,
        mime: p.mime ?? '',
        name: note.name,
        ...extra,
      },
    });
  }

  private async surfaceMedia(ctx: MediaCtx, p: SavedMedia): Promise<void> {
    const ownUser = agentUser() !== null;
    const note = await buildMediaNote(p, ctx.text ?? '', !ownUser);
    if (!note) return;
    await this.surfaceNote(ctx, p, note, {
      ...(p.url ? { url: p.url } : {}),
      ...(ownUser ? {} : { local_path: note.path }),
    });
  }

  private surfaceMediaFailure(ctx: MediaCtx, p: SavedMedia): Promise<void> {
    return this.surfaceNote(ctx, p, buildMediaFailureNote(p, ctx.text ?? ''), {
      attachment_error: p.reason ?? '',
    });
  }

  private async flushPendingFallback(id: string): Promise<void> {
    const e = this.pendingAttachments.get(id);
    if (!e) return;
    this.pendingAttachments.delete(id);
    const missing = e.attachments.filter((_, i) => !e.saved.has(i));
    if (!missing.length) return;
    const names = missing
      .map((a) => a.name ?? a.kind ?? 'attachment')
      .join(', ');
    await this.notify('notifications/claude/channel', {
      content:
        (e.text ? `${e.text}\n` : '') +
        `[attachment(s) could not be fetched in time: ${names}]`,
      meta: {
        line: e.line,
        from: e.from,
        station: e.station,
        ...tsMeta(e.ts),
        message_id: e.messageId,
        line_name: e.lineName,
        from_name: e.fromName,
        ...displayNameMeta(e.fromDisplayName),
        ...e.reply,
      },
    });
  }

  private mediaCtxFor(
    ev: Record<string, unknown>,
    payload: SavedMedia,
  ): MediaCtx | null {
    const forId = str(payload.attachmentFor);
    const buf = forId ? this.pendingAttachments.get(forId) : undefined;
    if (buf) {
      buf.saved.add(typeof payload.index === 'number' ? payload.index : 0);
      const ctx = takeMediaCtx(buf);
      if (buf.saved.size >= buf.attachments.length) {
        clearTimeout(buf.timer);
        this.pendingAttachments.delete(forId);
      }
      return ctx;
    }
    const line = str(ev.line);
    if (!line || !this.allowedLines.has(line)) return null;
    return {
      line,
      from: 'metro://attachment',
      station: str(ev.station) || 'xmtp',
      ts: str(ev.ts),
    };
  }

  private async routeAttachment(ev: Record<string, unknown>): Promise<boolean> {
    const p = ev.payload as SavedMedia | undefined;
    if (!p) return false;
    const type = p.contentType;
    if (type !== 'attachmentSaved' && type !== 'attachmentFailed') return false;
    const ctx = this.mediaCtxFor(ev, p);
    if (!ctx) return true;
    if (type === 'attachmentFailed') await this.surfaceMediaFailure(ctx, p);
    else await this.surfaceMedia(ctx, p);
    return true;
  }

  private bufferAttachments(
    ev: Record<string, unknown>,
    base: { line: string; from: string; station: string; text: string },
    atts: PendingAtt[],
  ): void {
    const id = str(ev.id);
    if (!id) return;
    const existing = this.pendingAttachments.get(id);
    if (existing) clearTimeout(existing.timer);
    this.pendingAttachments.set(id, {
      ...base,
      ts: str(ev.ts),
      messageId: str(ev.messageId),
      lineName: str(ev.lineName),
      fromName: str(ev.fromName),
      fromDisplayName: str(ev.fromDisplayName),
      reply: replyMeta(ev, this.sentIds),
      attachments: atts.map((a) => ({ kind: a.kind, name: a.name })),
      saved: new Set<number>(),
      timer: setTimeout(() => {
        this.flushPendingFallback(id).catch((err: unknown) => {
          this.deps.log(
            'inbound: attachment fallback not delivered',
            'id',
            id,
            'line',
            base.line,
            err,
          );
        });
      }, ATTACH_TIMEOUT_MS),
    });
  }

  private async handleReact(
    ev: Record<string, unknown>,
    base: { line: string; from: string; station: string; text: string },
  ): Promise<void> {
    const re = ev.event as { emoji?: unknown; targetId?: string };
    const emoji = reactionEmoji(re.emoji);
    const target = re.targetId ?? str(ev.messageId);
    const removed =
      (ev.payload as { removed?: boolean } | undefined)?.removed === true ||
      / \(removed\)\]?$/.test(base.text);
    const content = reactContent(emoji, target, removed);
    await this.notify('notifications/claude/channel', {
      content,
      meta: {
        line: base.line,
        from: base.from,
        station: base.station,
        ...tsMeta(ev.ts),
        message_id: str(ev.messageId),
        line_name: str(ev.lineName),
        from_name: str(ev.fromName),
        ...displayNameMeta(ev.fromDisplayName),
        reaction: emoji,
        target_id: target,
      },
    });
  }

  private async handlePermissionReply(ev: Record<string, unknown>, base: EventBase): Promise<boolean> {
    const answer = this.deps.answerPermission;
    if (answer === undefined || base.evType !== 'msg' || !this.approves(base.station) || ev.senderVerified === false) return false;
    const m = PERMISSION_REPLY_RE.exec(base.text);
    if (m?.[1] === undefined || m[2] === undefined) return false;
    return answer(m[2].toLowerCase(), m[1].toLowerCase().startsWith('y') ? 'allow' : 'deny', base.line, base.from);
  }

  private approves(station: string): boolean {
    return this.deps.approves?.(station) !== false;
  }

  private noteLine(base: EventBase): void {
    if (base.evType !== 'system' && this.approves(base.station)) this.lastLine = base.line;
    if (!base.line) return;
    this.allowedLines.add(base.line);
    capSet(this.allowedLines, ALLOWED_LINES_MAX);
  }

  private droppedSender(from: string, line: string, verified: unknown): boolean {
    if (
      from.startsWith('metro://claude') ||
      from === 'metro://user' ||
      !from.startsWith('metro://')
    )
      return true;
    if (!this.deps.senderAllowed(from, line, typeof verified === 'boolean' ? verified : undefined)) {
      this.deps.log('drop: sender not allowed', from);
      return true;
    }
    return false;
  }

  private routable(
    ev: Record<string, unknown>,
    replay: boolean,
  ): EventBase | null {
    const rawType = ev.event ? (ev.event as { type?: string }).type : 'msg';
    const evType = rawType === 'reply' ? 'msg' : rawType;
    if (evType !== 'msg' && evType !== 'react' && evType !== 'system')
      return null;
    const station = str(ev.station);
    if (!this.deps.getStations().has(station)) return null;
    const from = str(ev.from);
    const line = str(ev.line);
    if (this.droppedSender(from, line, ev.senderVerified)) return null;
    const text = str(ev.text);
    if (!replay && this.isDuplicate(station, line, evType, str(ev.messageId))) {
      this.deps.log(
        'drop: duplicate (per-account) event',
        evType,
        station,
        str(ev.messageId),
      );
      return null;
    }
    return { evType, station, from, line, text };
  }

  private async emitMessage(
    ev: Record<string, unknown>,
    base: EventBase,
  ): Promise<void> {
    if (base.evType === 'msg' && base.text.trim() === '') {
      this.deps.log('drop: empty message', base.station, base.line, str(ev.messageId));
      return;
    }
    if (await this.handlePermissionReply(ev, base)) return;
    await this.notify('notifications/claude/channel', {
      content:
        base.evType === 'system'
          ? buildWebhookNote(base.text, str(ev.lineName), ev.payload)
          : base.text,
      meta: {
        line: base.line,
        from: base.from,
        station: base.station,
        ...tsMeta(ev.ts),
        message_id: str(ev.messageId),
        line_name: str(ev.lineName),
        from_name: str(ev.fromName),
        ...displayNameMeta(ev.fromDisplayName),
        ...replyMeta(ev, this.sentIds),
      },
    });
  }

  async handleEvent(
    ev: Record<string, unknown>,
    replay = false,
  ): Promise<void> {
    if (await this.routeAttachment(ev)) return;

    const base = this.routable(ev, replay);
    if (!base) return;
    this.noteLine(base);

    const atts = (ev.payload as { attachments?: PendingAtt[] } | undefined)
      ?.attachments;
    if (Array.isArray(atts) && atts.length) {
      this.bufferAttachments(ev, base, atts);
      return;
    }

    if (base.evType === 'react') {
      await this.handleReact(ev, base);
      return;
    }
    await this.emitMessage(ev, base);
  }
}

interface EventBase {
  evType: string;
  station: string;
  from: string;
  line: string;
  text: string;
}

