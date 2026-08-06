import { str } from '../mcp/str.js';

export interface PendingAtt {
  kind?: string;
  name?: string;
}

export interface PendingMsg {
  line: string;
  from: string;
  station: string;
  text: string;
  messageId: string;
  lineName: string;
  fromName: string;
  fromDisplayName: string;
  attachments: PendingAtt[];
  saved: Set<number>;
  timer: ReturnType<typeof setTimeout>;
}

export interface MediaCtx {
  line: string;
  from: string;
  station: string;
  text?: string;
  messageId?: string;
  lineName?: string;
  fromName?: string;
  fromDisplayName?: string;
}

export function capSet(set: Set<string>, max: number): void {
  while (set.size > max) {
    const oldest = set.values().next();
    if (oldest.done) break;
    set.delete(oldest.value);
  }
}

export const displayNameMeta = (v: unknown): Record<string, string> => {
  const name = str(v);
  return name ? { from_display_name: name } : {};
};

export const senderMeta = (c: MediaCtx): Record<string, string> => ({
  ...(c.messageId ? { message_id: c.messageId } : {}),
  ...(c.lineName ? { line_name: c.lineName } : {}),
  ...(c.fromName ? { from_name: c.fromName } : {}),
  ...displayNameMeta(c.fromDisplayName),
});

export function takeMediaCtx(buf: PendingMsg): MediaCtx {
  const ctx: MediaCtx = {
    line: buf.line,
    from: buf.from,
    station: buf.station,
    text: buf.text,
    messageId: buf.messageId,
    lineName: buf.lineName,
    fromName: buf.fromName,
    fromDisplayName: buf.fromDisplayName,
  };
  buf.text = '';
  return ctx;
}
