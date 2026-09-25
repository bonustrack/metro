import { mintId } from '../ids.js';
import { emit } from './station-runtime.js';

type Fields = Record<string, unknown>;
type Out = (e: unknown) => void;

export const selfUri = (station: string, account?: string): string =>
  process.env.METRO_SELF_URI ??
  (account === undefined ? `metro://${station}/self` : `metro://${station}/${account}/self`);

export function emitInbound(account: string, e: Fields, out: Out = emit): void {
  out({
    ...e,
    payload: { ...(e.payload as Fields | undefined), account },
  });
}

export interface AttachmentAt {
  station: string;
  account: string;
  line: string;
  forId: string;
  index: number;
  from?: string;
}

export interface SavedFile {
  path: string;
  mime?: string;
  name?: string;
  bytes?: number;
}

function attachmentEvent(at: AttachmentAt, text: string, payload: Fields): Fields {
  return {
    id: mintId(),
    ts: new Date().toISOString(),
    station: at.station,
    line: at.line,
    from: at.from ?? selfUri(at.station, at.account),
    text,
    payload: { account: at.account, attachmentFor: at.forId, index: at.index, ...payload },
  };
}

export const attachmentSavedEvent = (at: AttachmentAt & { saved: SavedFile; extra?: Fields }): Fields =>
  attachmentEvent(at, `📎 saved: ${at.saved.path}`, {
    contentType: 'attachmentSaved',
    ...(at.saved.bytes === undefined ? {} : { size: at.saved.bytes }),
    ...at.extra,
    attachmentPath: at.saved.path,
    mime: at.saved.mime,
    name: at.saved.name,
  });

export const attachmentFailedEvent = (at: AttachmentAt & { reason: string; extra?: Fields }): Fields =>
  attachmentEvent(at, `📎 not fetched: ${at.reason}`, {
    contentType: 'attachmentFailed',
    ...at.extra,
    reason: at.reason,
  });

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function reportAttachment(
  save: Promise<SavedFile>,
  at: AttachmentAt,
  extra: { saved?: Fields; failed?: Fields } = {},
  out: Out = emit,
): void {
  const tag = `${at.station}[${at.account}]`;
  save
    .then(
      (saved) => {
        out(attachmentSavedEvent({ ...at, saved, extra: extra.saved }));
      },
      (err: unknown) => {
        const reason = reasonOf(err);
        process.stderr.write(`${tag} attachment save failed: ${reason}\n`);
        out(attachmentFailedEvent({ ...at, reason, extra: extra.failed }));
      },
    )
    .catch((err: unknown) => {
      process.stderr.write(`${tag} attachment event not emitted: ${reasonOf(err)}\n`);
    });
}
