import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { applyTurnEvent, type ChatPart, type ReplyState } from '@metro-labs/core/chat';
import { ForbiddenError, HttpError, NotFoundError } from '@metro-labs/client/api/client';
import { pollTurn, sendTurn, stopTurn, type Delivery, type TurnView } from '@metro-labs/client/api/chat-turns';
import { viewTicket } from '@metro-labs/client/api/chats';
import { refreshChat, refreshChats, sendChatMessage } from './chat-queries.js';
import { takeGoOns, takeSend, type Send } from './chat-sends.js';
import { logError } from './log.js';
import { queryError } from './queries.js';

type LivePhase = 'idle' | 'starting' | 'live' | 'done' | 'missing' | 'failed';

export type TryAgain = 'send' | 'watch';

export interface LiveTurn {
  phase: LivePhase;
  parts: ChatPart[];
  state: ReplyState | null;
  error: string | null;
  delivery: Delivery;
  again: TryAgain;
}

const IDLE_TURN: LiveTurn = { phase: 'idle', parts: [], state: null, error: null, delivery: 'pending', again: 'send' };

const RETRY_MS = 2_000;
const POLL_MS = 40_000;
const RENEW_GAP_MS = 60_000;
const STARTING_MS = 30_000;
const FAILURES_MAX = 5;
const UNREACHED = 'The agent could not be reached.';

export const replyGoing = (live: LiveTurn): boolean => live.phase === 'starting' || live.phase === 'live';

export const replyHolds = (live: LiveTurn): boolean => live.phase === 'idle' || replyGoing(live) || (live.phase === 'done' && live.delivery === 'pending');

export interface TurnApi {
  send: typeof sendTurn;
  poll: typeof pollTurn;
  stop: typeof stopTurn;
  renew: typeof viewTicket;
}

const TURN_API: TurnApi = { send: sendTurn, poll: pollTurn, stop: stopTurn, renew: viewTicket };

interface WatchOptions {
  api: TurnApi;
  host: string;
  chat: string;
  message: string;
  sentAt: number;
  ticket: () => string;
  onChange: (turn: LiveTurn) => void;
  onDone: (delivery: Delivery) => void;
  onStopFailed: (error: string) => void;
  signal: AbortSignal;
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function bounded<T>(signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const control = new AbortController();
  const stop = (): void => { control.abort(); };
  const timer = setTimeout(stop, POLL_MS);
  signal.addEventListener('abort', stop, { once: true });
  try {
    return await run(control.signal);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
  }
}

const busyChat = (err: unknown): boolean => err instanceof HttpError && err.status === 409;

export class TurnWatch {
  private after = 0;
  private parts: ChatPart[] = [];
  private failures = 0;
  private ticket: string | null = null;
  private renewedAt = 0;
  private known = false;
  private stopWanted = false;
  private stopSent = false;

  constructor(private readonly opts: WatchOptions) {}

  requestStop(): void {
    this.stopWanted = true;
    this.sendStop();
  }

  private currentTicket(): string {
    return this.ticket ?? this.opts.ticket();
  }

  private sendStop(): void {
    if (!this.known || !this.stopWanted || this.stopSent) return;
    this.stopSent = true;
    this.opts.api.stop(this.opts.host, this.opts.message, this.currentTicket()).catch((err: unknown) => {
      this.stopSent = false;
      this.stopWanted = false;
      if (!this.opts.signal.aborted) this.opts.onStopFailed(queryError(err, 'The reply was not stopped.'));
    });
  }

  private show(turn: Partial<LiveTurn>): void {
    if (!this.opts.signal.aborted) this.opts.onChange({ ...IDLE_TURN, parts: this.parts, ...turn });
  }

  private failed(err: unknown, again: TryAgain, fallback = UNREACHED): false {
    this.show({ phase: 'failed', error: queryError(err, fallback), again });
    return false;
  }

  private async start(): Promise<boolean> {
    const send = takeSend(this.opts.message);
    return send === null ? true : this.hand(send);
  }

  private async hand(send: Send): Promise<boolean> {
    this.show({ phase: 'starting' });
    try {
      await this.opts.api.send(this.opts.host, send.ticket, send.text);
    } catch (err) {
      if (!busyChat(err)) return this.failed(err, 'send');
      this.show({ phase: 'idle' });
      return true;
    }
    this.known = true;
    this.show({ phase: 'live' });
    this.sendStop();
    return true;
  }

  private async refused(err: unknown): Promise<boolean> {
    if (err instanceof NotFoundError) return this.notYet();
    if (err instanceof ForbiddenError && Date.now() - this.renewedAt > RENEW_GAP_MS) return this.renew();
    this.failures += 1;
    if (this.failures > FAILURES_MAX || err instanceof ForbiddenError) return this.failed(err, 'watch');
    await pause(RETRY_MS);
    return true;
  }

  private async notYet(): Promise<boolean> {
    const send = takeSend(this.opts.message);
    if (send !== null) return this.hand(send);
    if (Date.now() - this.opts.sentAt > STARTING_MS) {
      this.show({ phase: 'missing', again: 'send' });
      return false;
    }
    await pause(RETRY_MS);
    return true;
  }

  private async renew(): Promise<boolean> {
    this.renewedAt = Date.now();
    try {
      this.ticket = await this.opts.api.renew(this.opts.chat);
      return true;
    } catch (err) {
      return this.failed(err, 'watch', 'metro.box did not answer.');
    }
  }

  private take(view: TurnView): boolean {
    this.failures = 0;
    if (view.parts !== null) this.parts = view.parts;
    for (const event of view.events) this.parts = applyTurnEvent(this.parts, event);
    this.after = view.seq;
    if (!view.done) {
      this.known = true;
      this.sendStop();
    }
    const finished = view.done && view.delivery !== 'pending';
    this.show({ phase: view.done ? 'done' : 'live', state: view.state, error: view.error, delivery: view.delivery });
    if (finished) this.opts.onDone(view.delivery);
    return !finished;
  }

  async run(): Promise<void> {
    if (!(await this.start())) return;
    let going = true;
    while (going && !this.opts.signal.aborted) {
      try {
        const view = await bounded(this.opts.signal, (signal) => this.opts.api.poll(this.opts.host, this.opts.message, this.currentTicket(), this.after, signal));
        going = this.take(view);
      } catch (err) {
        going = !this.opts.signal.aborted && (await this.refused(err));
      }
    }
  }
}

export interface Pending {
  id: string;
  at: number;
}

export interface LiveReply {
  live: LiveTurn;
  stopping: boolean;
  stopError: string | null;
  stop: () => void;
}

interface Shown {
  key: string;
  live: LiveTurn;
}

export function useLiveTurn(host: string | null, chat: string, pending: Pending | null, ticket: string, attempt: number): LiveReply {
  const client = useQueryClient();
  const [shown, setShown] = useState<Shown | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const watch = useRef<TurnWatch | null>(null);
  const current = useRef(ticket);
  current.current = ticket;
  const message = pending?.id ?? null;
  const at = pending?.at ?? 0;
  const key = `${host ?? ''}:${message ?? ''}:${String(at)}:${String(attempt)}`;
  useEffect(() => {
    setStopping(false);
    setStopError(null);
    if (host === null || message === null) return undefined;
    const control = new AbortController();
    const onDone = (delivery: Delivery): void => {
      refreshChat(client, chat)
        .then(() => refreshChats(client))
        .catch(logError('chat refresh'));
      if (delivery !== 'saved') return;
      for (const text of takeGoOns(message)) sendChatMessage(client, chat, text).catch(logError('chat go on'));
    };
    const onStopFailed = (error: string): void => {
      setStopping(false);
      setStopError(error);
    };
    const onChange = (live: LiveTurn): void => { setShown({ key, live }); };
    const created = new TurnWatch({ api: TURN_API, host, chat, message, sentAt: at, ticket: () => current.current, onChange, onDone, onStopFailed, signal: control.signal });
    watch.current = created;
    created.run().catch(logError('chat turn'));
    return () => {
      control.abort();
      if (watch.current === created) watch.current = null;
    };
  }, [client, host, chat, message, at, key]);
  const stop = (): void => {
    setStopping(true);
    setStopError(null);
    watch.current?.requestStop();
  };
  return { live: shown?.key === key ? shown.live : IDLE_TURN, stopping, stopError, stop };
}
