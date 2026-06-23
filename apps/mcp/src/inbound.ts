import { stat } from 'node:fs/promises';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

export function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

interface InboundDeps {
  mcp: Server;
  log: (...a: unknown[]) => void;
  getStations: () => Set<string>;
  senderAllowed: (from: string) => boolean;
  metroSend: (line: string, text: string, replyTo?: string) => Promise<void>;
}

interface PendingAtt {
  kind?: string;
  name?: string;
}

interface PendingMsg {
  line: string;
  from: string;
  station: string;
  text: string;
  messageId: string;
  lineName: string;
  attachments: PendingAtt[];
  saved: Set<number>;
  timer: ReturnType<typeof setTimeout>;
}

interface SavedMedia {
  contentType?: string;
  attachmentFor?: string;
  attachmentPath?: string;
  localPath?: string;
  url?: string;
  mime?: string;
  name?: string;
  index?: number;
}

const ATTACH_TIMEOUT_MS = 15_000;
const MAX_INLINE_BYTES = 4 * 1024 * 1024;
const DEDUPE_TTL_MS = 30_000;
const DEDUPE_MAX = 2_000;
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

function mediaKind(mime?: string, name?: string): string {
  const m = (mime ?? '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  const n = name ?? '';
  if (/\.(png|jpe?g|gif|webp|heic)$/i.test(n)) return 'image';
  if (/\.(mp4|mov|webm|m4v)$/i.test(n)) return 'video';
  if (/\.(m4a|mp3|ogg|wav)$/i.test(n)) return 'audio';
  return 'file';
}

const shortId = (id: string): string =>
  id.length > 10 ? `${id.slice(0, 6)}…` : id;

const accountStrippedLine = (line: string): string => {
  const parts = line.split('/');
  if (parts.length < 5) return line;
  return [parts[0], parts[1], parts[2], ...parts.slice(4)].join('/');
};

export class InboundRelay {
  private readonly deps: InboundDeps;
  private readonly pendingAttachments = new Map<string, PendingMsg>();
  private readonly seenEvents = new Map<string, number>();
  private readonly allowedLines = new Set<string>();
  private readonly pendingPermissions = new Map<string, string>();
  private lastLine: string | undefined;

  constructor(deps: InboundDeps) {
    this.deps = deps;
  }

  get knownLine(): string | undefined {
    return this.lastLine;
  }

  registerPermission(requestId: string, line: string): void {
    this.pendingPermissions.set(requestId, line);
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
    const key = `${station} ${accountStrippedLine(line)} ${kind} ${messageId}`;
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

  private async surfaceMedia(
    ctx: { line: string; from: string; station: string },
    p: SavedMedia,
  ): Promise<void> {
    const path = p.attachmentPath ?? p.localPath;
    if (!path) return;
    const kind = mediaKind(p.mime, p.name);
    const name = p.name ?? path.split('/').pop() ?? 'attachment';
    const size = await fileSize(path);
    const tooBig = size > MAX_INLINE_BYTES;
    const sizeNote = size ? ` (${(size / 1024 / 1024).toFixed(2)} MB)` : '';
    const content =
      `[${kind} attachment received: ${name}${p.mime ? `, ${p.mime}` : ''}${sizeNote}]\n` +
      `Saved locally at: ${path}\n` +
      (p.url ? `Public URL: ${p.url}\n` : '') +
      (tooBig
        ? 'Large file - inspect on disk only as needed (do not inline).'
        : 'Use the Read tool on that absolute path to view/inspect it.');
    await this.notify('notifications/claude/channel', {
      content,
      meta: {
        line: ctx.line,
        from: ctx.from,
        station: ctx.station,
        kind,
        mime: p.mime ?? '',
        name,
        local_path: path,
      },
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
        message_id: e.messageId,
        line_name: e.lineName,
      },
    });
  }

  private async handleAttachmentSaved(
    ev: Record<string, unknown>,
    payload: SavedMedia,
  ): Promise<void> {
    const line = str(ev.line);
    const forId = str(payload.attachmentFor);
    const buf = forId ? this.pendingAttachments.get(forId) : undefined;
    if (buf) {
      const idx = typeof payload.index === 'number' ? payload.index : 0;
      buf.saved.add(idx);
      await this.surfaceMedia(
        { line: buf.line, from: buf.from, station: buf.station },
        payload,
      );
      if (buf.saved.size >= buf.attachments.length) {
        clearTimeout(buf.timer);
        this.pendingAttachments.delete(forId);
      }
    } else if (line && this.allowedLines.has(line)) {
      await this.surfaceMedia(
        { line, from: 'metro://attachment', station: str(ev.station) || 'xmtp' },
        payload,
      );
    }
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
      messageId: str(ev.messageId),
      lineName: str(ev.lineName),
      attachments: atts.map((a) => ({ kind: a.kind, name: a.name })),
      saved: new Set<number>(),
      timer: setTimeout(() => {
        void this.flushPendingFallback(id);
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
    const verb = removed ? 'removed from' : 'reacted to';
    const label = removed ? emoji || 'reaction' : emoji || 'reacted';
    const content = `${label} ${verb} message ${shortId(target)}`.trim();
    await this.notify('notifications/claude/channel', {
      content,
      meta: {
        line: base.line,
        from: base.from,
        station: base.station,
        message_id: str(ev.messageId),
        line_name: str(ev.lineName),
        reaction: emoji,
        target_id: target,
      },
    });
  }

  private async handlePermissionReply(text: string): Promise<boolean> {
    const m = PERMISSION_REPLY_RE.exec(text);
    if (m?.[1] === undefined || m[2] === undefined || !this.pendingPermissions.size)
      return false;
    const id = m[2].toLowerCase();
    if (!this.pendingPermissions.has(id)) return false;
    this.pendingPermissions.delete(id);
    await this.notify('notifications/claude/channel/permission', {
      request_id: id,
      behavior: m[1].toLowerCase().startsWith('y') ? 'allow' : 'deny',
    });
    return true;
  }

  private droppedSender(from: string): boolean {
    if (
      from.startsWith('metro://claude') ||
      from === 'metro://user' ||
      !from.startsWith('metro://')
    )
      return true;
    if (!this.deps.senderAllowed(from)) {
      this.deps.log('drop: sender not allowed', from);
      return true;
    }
    return false;
  }

  private routable(ev: Record<string, unknown>): EventBase | null {
    const evType = ev.event ? (ev.event as { type?: string }).type : 'msg';
    if (evType !== 'msg' && evType !== 'react') return null;
    const station = str(ev.station);
    if (station === 'webhook' || !this.deps.getStations().has(station))
      return null;
    const from = str(ev.from);
    if (this.droppedSender(from)) return null;
    const line = str(ev.line);
    const text = str(ev.text);
    if (this.isDuplicate(station, line, evType, str(ev.messageId))) {
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
    if (await this.handlePermissionReply(base.text)) return;
    await this.notify('notifications/claude/channel', {
      content: base.text,
      meta: {
        line: base.line,
        from: base.from,
        station: base.station,
        message_id: str(ev.messageId),
        line_name: str(ev.lineName),
      },
    });
  }

  async handleEvent(ev: Record<string, unknown>): Promise<void> {
    const payload = ev.payload as SavedMedia | undefined;
    if (payload?.contentType === 'attachmentSaved') {
      await this.handleAttachmentSaved(ev, payload);
      return;
    }

    const base = this.routable(ev);
    if (!base) return;
    this.lastLine = base.line;
    if (base.line) this.allowedLines.add(base.line);

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

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

function reactionEmoji(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  const obj = raw as { name?: string; reaction?: string } | undefined;
  return obj?.name ?? obj?.reaction ?? '';
}
