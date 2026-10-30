import { useEffect, useRef, useState } from 'react';
import { AttachLifetime } from '@metro-labs/client/api/attach-lifetime';
import { accountIdentity, checkAccountIdentity, shareActiveAccount, type AccountIdentity } from '@metro-labs/client/auth/account';
import { agentsUrl } from '@metro-labs/client/api/client';
import { type AttachStarted } from '@metro-labs/client/api/attach';
import { stateOf, type AttachSession } from '@metro-labs/client/api/attach-session';
import { rememberSignIn } from '@metro-labs/client/api/sign-in-return';
import { location } from '@metro-labs/client/platform';
import { inNewTab } from '../components/sign-in-tab.js';
import { logError } from './log.js';

export type SignInOpened = 'tab' | 'blocked';

interface SignInTarget {
  agentId: string;
  base: string;
  identity: AccountIdentity | null;
  attachId: string;
  authorizeUrl: string;
}

export function prepareSignIn(target: SignInTarget): void {
  checkAccountIdentity(target.identity);
  rememberSignIn({
    state: stateOf(target.authorizeUrl),
    agentsBase: target.base,
    agentId: target.agentId,
    attachId: target.attachId,
    backHash: location().hash(),
    startedAt: Date.now(),
    identity: target.identity,
  });
  shareActiveAccount().catch(logError('share the account with the sign-in tab'));
}

export function useAttach(agentId: string) {
  const base = agentsUrl();
  const [identity] = useState(accountIdentity);
  const life = useRef<AttachLifetime | null>(null);
  const [started, setStarted] = useState<AttachStarted | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<SignInOpened | null>(null);

  useEffect(() => {
    const current = new AttachLifetime(agentId, base, identity);
    life.current = current;
    setStarted(null);
    setBusy(false);
    setError(null);
    setOpened(null);
    return () => {
      life.current = null;
      current.close().catch(logError('cancel channel sign-in'));
    };
  }, [agentId, base, identity]);

  const start = (station: string, fields: Record<string, string>, pairAgain?: string): void => {
    const current = life.current;
    if (current === null || busy) return;
    setBusy(true);
    setError(null);
    current.start(station, fields, pairAgain)
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

  const startInTab = (station: string, fields: Record<string, string>): void => {
    const current = life.current;
    if (current === null || busy) return;
    setBusy(true);
    setError(null);
    let sent = false;
    let blocked = false;
    const urlOf = (next: AttachStarted | null): string | null => {
      if (next?.kind !== 'pending' || next.session.authorizeUrl === null || life.current !== current) return null;
      prepareSignIn({ agentId, base, identity, attachId: next.session.attachId, authorizeUrl: next.session.authorizeUrl });
      sent = true;
      return next.session.authorizeUrl;
    };
    inNewTab(() => current.start(station, fields), urlOf, () => { blocked = true; })
      .then((next) => {
        if (next === null || life.current !== current) return;
        setOpened(sent ? (blocked ? 'blocked' : 'tab') : null);
        setStarted(next);
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

  return { base, identity, started, busy, error, opened, start, startInTab, update, close, clearError };
}
