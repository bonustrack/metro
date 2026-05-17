/**
 * Tiny SSE reader.
 *
 * React Native's `fetch` returns a streamed response body via `.body` (a
 * web-style ReadableStream) on iOS/Android since RN 0.74. We use that
 * directly — no EventSource polyfill, no extra deps. Reconnects are caller-driven.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { HistoryEntry } from './types';

type SseEvent = { id?: string; event?: string; data?: string };

/** Parse SSE frames out of a rolling string buffer. Returns parsed events + remaining tail. */
function parseFrames(buf: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  let rest = buf;
  while (true) {
    const sep = rest.indexOf('\n\n');
    if (sep === -1) break;
    const block = rest.slice(0, sep);
    rest = rest.slice(sep + 2);
    const evt: SseEvent = {};
    for (const lineRaw of block.split('\n')) {
      const line = lineRaw.replace(/\r$/, '');
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'id') evt.id = value;
      else if (field === 'event') evt.event = value;
      else if (field === 'data') evt.data = (evt.data ? evt.data + '\n' : '') + value;
    }
    if (evt.data !== undefined) events.push(evt);
  }
  return { events, rest };
}

export type TailOptions = {
  daemonUrl: string;
  token: string;
  as?: string;
  chat?: string;
  station?: string;
  includeWebhooks?: boolean;
};

/**
 * React hook — opens an SSE stream to `/api/tail`, accumulates events newest-first,
 * exposes status + the list. Caller owns lifecycle via the `enabled` flag.
 */
export function useTail(opts: TailOptions, enabled: boolean): {
  events: HistoryEntry[];
  status: 'idle' | 'connecting' | 'open' | 'error' | 'closed';
  error: string | null;
  reconnect: () => void;
} {
  const [events, setEvents] = useState<HistoryEntry[]>([]);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'open' | 'error' | 'closed'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const reconnect = useCallback(() => {
    setEvents([]);
    setTick(t => t + 1);
  }, []);

  useEffect(() => {
    if (!enabled || !opts.daemonUrl || !opts.token) {
      setStatus('idle');
      return;
    }

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setStatus('connecting');
    setError(null);

    const params = new URLSearchParams();
    if (opts.as) params.set('as', opts.as);
    if (opts.chat) params.set('chat', opts.chat);
    if (opts.station) params.set('station', opts.station);
    if (opts.includeWebhooks) params.set('include_webhooks', 'true');
    const qs = params.toString();
    const url = `${opts.daemonUrl.replace(/\/$/, '')}/api/tail${qs ? `?${qs}` : ''}`;

    (async (): Promise<void> => {
      try {
        const res = await fetch(url, {
          headers: { authorization: `Bearer ${opts.token}` },
          signal: ctrl.signal,
        });
        if (!res.ok) {
          setStatus('error');
          setError(`HTTP ${res.status}`);
          return;
        }
        if (!res.body) {
          setStatus('error');
          setError('no response body');
          return;
        }
        setStatus('open');
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const { events: parsed, rest } = parseFrames(buf);
          buf = rest;
          if (parsed.length > 0) {
            const entries: HistoryEntry[] = [];
            for (const e of parsed) {
              if (e.event !== 'history' || !e.data) continue;
              try { entries.push(JSON.parse(e.data) as HistoryEntry); }
              catch { /* skip malformed */ }
            }
            if (entries.length > 0) {
              /** Newest-first, capped at 500 to keep the list bounded. */
              setEvents(prev => [...entries.reverse(), ...prev].slice(0, 500));
            }
          }
        }
        setStatus('closed');
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setStatus('error');
        setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return (): void => { ctrl.abort(); };
  }, [enabled, opts.daemonUrl, opts.token, opts.as, opts.chat, opts.station, opts.includeWebhooks, tick]);

  return { events, status, error, reconnect };
}

/** One-shot GET helper for `/api/state` (no SSE). */
export async function fetchState(
  daemonUrl: string,
  token: string,
): Promise<{ ok: true; data: unknown } | { ok: false; status: number; error: string }> {
  try {
    const res = await fetch(`${daemonUrl.replace(/\/$/, '')}/api/state`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}
