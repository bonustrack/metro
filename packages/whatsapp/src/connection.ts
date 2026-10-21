import { DisconnectReason } from 'baileys';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg } from '@metro-labs/core/log';
import { TrainError } from '@metro-labs/core/train-error';
import { accountStatus, type AccountStatus } from '@metro-labs/core/stations/account-status';

export const RECONNECT_GRACE_MS = 3 * 60_000;
export const SILENT_MS = 90_000;
const CHECK_MS = 30_000;

const TERMINAL: Record<number, string> = {
  [DisconnectReason.loggedOut]: ' — re-pair required',
  [DisconnectReason.connectionReplaced]:
    ' — another metro took this device; not reconnecting (two sockets on one ' +
    'identity evict each other and risk a 463 timelock)',
};

export function terminalReason(code: number | undefined): string | undefined {
  return code === undefined ? undefined : TERMINAL[code];
}

export const closeReason = (closed: Closed): string | undefined =>
  terminalReason(closed.removed ? DisconnectReason.loggedOut : closed.code);

export interface Closed {
  code: number | undefined;
  message: string;
  removed: boolean;
}

const recordOf = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

export function closeOf(error: unknown): Closed {
  const boom = recordOf(error);
  const output = recordOf(boom.output);
  const data = recordOf(boom.data);
  return {
    code: typeof output.statusCode === 'number' ? output.statusCode : undefined,
    message: error instanceof Error ? error.message : '',
    removed: data.tag === 'conflict' && recordOf(data.attrs).type === 'device_removed',
  };
}

export function statusAfterClose(closed: Closed, now: number): AccountStatus {
  if (closed.removed) return accountStatus('logged_out', 'WhatsApp removed this linked device.', now);
  if (closed.code === DisconnectReason.loggedOut) return accountStatus('logged_out', 'WhatsApp logged this device out.', now);
  if (closed.code === DisconnectReason.connectionReplaced)
    return accountStatus('disconnected', 'Another Metro took over this WhatsApp device, so this one stopped.', now);
  const code = `code ${closed.code === undefined ? '?' : String(closed.code)}`;
  return accountStatus('connecting', `The connection dropped (${closed.message === '' ? code : `${closed.message}, ${code}`}).`, now);
}

export function failureOf(e: unknown, step: 'connect' | 'reconnect'): AccountStatus {
  if (e instanceof TrainError && e.code === 'whatsapp_auth') return accountStatus('logged_out', 'No WhatsApp link is stored for this channel.');
  return accountStatus('disconnected', `Metro could not ${step} to WhatsApp: ${errMsg(e)}`);
}

export interface Liveness {
  open: boolean;
  socketOpen: boolean;
  lastFrameAt: number;
}

function openStatus(current: AccountStatus, live: Liveness, now: number): AccountStatus {
  const trouble = !live.socketOpen ? 'The WhatsApp connection is not open.' : now - live.lastFrameAt > SILENT_MS ? 'WhatsApp stopped answering.' : null;
  if (trouble === null) return current.state === 'connected' ? current : accountStatus('connected', undefined, now);
  return current.state === 'connected' ? accountStatus('connecting', trouble, now) : current;
}

export function liveStatus(current: AccountStatus, live: Liveness, now: number): AccountStatus {
  if (current.state === 'logged_out') return current;
  const next = live.open ? openStatus(current, live, now) : current;
  if (next.state !== 'connecting' || now - next.since < RECONNECT_GRACE_MS) return next;
  return accountStatus('disconnected', `${next.reason ?? 'Metro could not reach WhatsApp.'} It has not come back for 3 minutes.`, next.since + RECONNECT_GRACE_MS);
}

export class ConnectionWatch {
  private status: AccountStatus;
  private open = false;
  private lastFrameAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly accountId: string,
    private readonly socketOpen: () => boolean,
    now = Date.now(),
  ) {
    this.status = accountStatus('connecting', undefined, now);
  }

  opened(now = Date.now()): void {
    this.open = true;
    this.lastFrameAt = now;
    this.enter(accountStatus('connected', undefined, now));
  }

  heard(now = Date.now()): void {
    this.lastFrameAt = now;
  }

  closed(closed: Closed, now = Date.now()): void {
    this.open = false;
    const next = statusAfterClose(closed, now);
    if (next.state !== 'connecting') this.enter(next);
    else if (this.status.state === 'connecting') this.enter(accountStatus('connecting', next.reason, this.status.since));
    else if (this.status.state !== 'disconnected') this.enter(next);
  }

  failed(status: AccountStatus): void {
    this.open = false;
    this.enter(status);
  }

  read(now = Date.now()): AccountStatus {
    const next = liveStatus(this.status, { open: this.open, socketOpen: this.socketOpen(), lastFrameAt: this.lastFrameAt }, now);
    if (next !== this.status) this.enter(next);
    return this.status;
  }

  watch(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this.read();
    }, CHECK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private enter(next: AccountStatus): void {
    const before = this.status.state;
    this.status = next;
    if (before === next.state) return;
    process.stderr.write(`whatsapp[${this.accountId}] state ${before} -> ${next.state}${next.reason === undefined ? '' : `: ${next.reason}`}\n`);
  }
}
