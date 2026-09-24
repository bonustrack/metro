import { isRecord } from '@metro-labs/core/is-record';
import { str } from '@metro-labs/core/str';

export interface ApprovalNote {
  content: string;
  meta: Record<string, string>;
}

export function approvalNote(ev: Record<string, unknown>): ApprovalNote | undefined {
  const kind = isRecord(ev.event) ? ev.event : {};
  if (kind.type !== 'system' || kind.source !== 'approval') return undefined;
  const notice = isRecord(ev.payload) && isRecord(ev.payload.approval) ? ev.payload.approval : {};
  return {
    content: str(ev.text),
    meta: {
      line: str(ev.line),
      from: str(ev.from),
      station: str(ev.station),
      ts: str(ev.ts),
      approval_id: str(notice.approvalId),
      tool: str(notice.tool),
      outcome: str(notice.verdict),
    },
  };
}

const shortId = (id: string): string => (id.length > 10 ? `${id.slice(0, 6)}…` : id);

export function reactionEmoji(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  const obj = raw as { name?: string; reaction?: string } | undefined;
  return obj?.name ?? obj?.reaction ?? '';
}

export function reactContent(emoji: string, target: string, removed: boolean): string {
  const verb = removed ? 'removed from' : 'reacted to';
  const label = removed ? emoji || 'reaction' : emoji || 'reacted';
  return `${label} ${verb} message ${shortId(target)}`.trim();
}
