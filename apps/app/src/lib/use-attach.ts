import { useEffect, useRef, useState } from 'react';
import { AttachLifetime } from '@metro-labs/client/api/attach-lifetime';
import { accountIdentity } from '@metro-labs/client/auth/account';
import { agentsUrl } from '@metro-labs/client/api/client';
import { type AttachStarted } from '@metro-labs/client/api/attach';
import { type AttachSession } from '@metro-labs/client/api/attach-session';
import { logError } from './log.js';

export function useAttach(agentId: string) {
  const base = agentsUrl();
  const [identity] = useState(accountIdentity);
  const life = useRef<AttachLifetime | null>(null);
  const [started, setStarted] = useState<AttachStarted | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const current = new AttachLifetime(agentId, base, identity);
    life.current = current;
    setStarted(null);
    setBusy(false);
    setError(null);
    return () => {
      life.current = null;
      current.close().catch(logError('cancel channel sign-in'));
    };
  }, [agentId, base, identity]);

  const start = (station: string, fields: Record<string, string>): void => {
    const current = life.current;
    if (current === null || busy) return;
    setBusy(true);
    setError(null);
    current.start(station, fields)
      .then((next) => {
        if (next !== null && life.current === current) setStarted(next);
      })
      .catch((err: unknown) => {
        if (life.current === current) setError(err instanceof Error ? err.message : 'Could not connect the channel.');
        else logError('channel sign-in after close')(err);
      })
      .finally(() => {
        if (life.current === current) setBusy(false);
      });
  };

  const update = (session: AttachSession): void => {
    if (life.current?.update(session) === true) setStarted({ kind: 'pending', session });
  };

  const close = (): void => {
    const current = life.current;
    life.current = null;
    current?.close().catch(logError('cancel channel sign-in'));
  };

  const clearError = (): void => { setError(null); };

  return { base, identity, started, busy, error, start, update, close, clearError };
}
