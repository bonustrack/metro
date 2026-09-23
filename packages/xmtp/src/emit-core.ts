import { accounts } from './accounts.js';
import { emit, mintId, SELF_URI } from './wire.js';

export function emitInbound(
  accountId: string,
  e: Record<string, unknown>,
): void {
  const acct = accounts.get(accountId);
  const owner = acct?.cfg.owner;
  const payload = {
    ...(e.payload as Record<string, unknown> | undefined),
    account: accountId,
  };
  emit({
    kind: 'inbound',
    ...e,
    ...(owner ? { to: owner } : {}),
    account: accountId,
    payload,
  });
}

export function emitAttachmentSaved(
  accountId: string,
  line: string,
  sourceMsgId: string,
  index: number,
  save: Promise<{ path: string; mime?: string; name?: string }>,
): void {
  void save
    .then((saved) => {
      emitInbound(accountId, {
        id: mintId(),
        ts: new Date().toISOString(),
        station: 'xmtp',
        line,
        from: SELF_URI,
        text: `📎 saved: ${saved.path}`,
        payload: {
          contentType: 'attachmentSaved',
          attachmentFor: sourceMsgId,
          index,
          attachmentPath: saved.path,
          localPath: saved.path,
          mime: saved.mime,
          name: saved.name,
        },
      });
    })
    .catch((err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`xmtp attachment save failed: ${reason}\n`);
      emitInbound(accountId, {
        id: mintId(),
        ts: new Date().toISOString(),
        station: 'xmtp',
        line,
        from: SELF_URI,
        text: `📎 not fetched: ${reason}`,
        payload: { contentType: 'attachmentFailed', attachmentFor: sourceMsgId, index, reason },
      });
    });
}
