import { str } from '@metro-labs/core/str';

export interface PendingAtt {
  kind?: string;
  name?: string;
}

export interface PendingMsg {
  line: string;
  from: string;
  station: string;
  text: string;
  ts: string;
  messageId: string;
  lineName: string;
  fromName: string;
  fromDisplayName: string;
  fromAvatar: string;
  fromAbout: string;
  attachments: PendingAtt[];
  saved: Set<number>;
  timer: ReturnType<typeof setTimeout>;
}

export interface MediaCtx {
  line: string;
  from: string;
  station: string;
  text?: string;
  ts?: string;
  messageId?: string;
  lineName?: string;
  fromName?: string;
  fromDisplayName?: string;
  fromAvatar?: string;
  fromAbout?: string;
}

export function capSet(set: Set<string>, max: number): void {
  while (set.size > max) {
    const oldest = set.values().next();
    if (oldest.done) break;
    set.delete(oldest.value);
  }
}

export const tsMeta = (v: unknown): Record<string, string> => {
  const ts = str(v);
  return ts ? { ts } : {};
};

const optional = (key: string, v: unknown): Record<string, string> => {
  const text = str(v);
  return text ? { [key]: text } : {};
};

export const profileMeta = (v: { fromDisplayName?: unknown; fromAvatar?: unknown; fromAbout?: unknown }): Record<string, string> => ({
  ...optional('from_display_name', v.fromDisplayName),
  ...optional('from_avatar', v.fromAvatar),
  ...optional('from_about', v.fromAbout),
});

export const senderMeta = (c: MediaCtx): Record<string, string> => ({
  ...tsMeta(c.ts),
  ...(c.messageId ? { message_id: c.messageId } : {}),
  ...(c.lineName ? { line_name: c.lineName } : {}),
  ...(c.fromName ? { from_name: c.fromName } : {}),
  ...profileMeta(c),
});

export function takeMediaCtx(buf: PendingMsg): MediaCtx {
  const ctx: MediaCtx = {
    line: buf.line,
    from: buf.from,
    station: buf.station,
    text: buf.text,
    ts: buf.ts,
    messageId: buf.messageId,
    lineName: buf.lineName,
    fromName: buf.fromName,
    fromDisplayName: buf.fromDisplayName,
    fromAvatar: buf.fromAvatar,
    fromAbout: buf.fromAbout,
  };
  buf.text = '';
  return ctx;
}
