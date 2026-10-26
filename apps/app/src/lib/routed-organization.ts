import { useEffect, useRef, useState } from 'react';
import { activeAccount } from '@metro-labs/client/auth/account';
import { isCurrentOrganization, openOrganization } from '@metro-labs/client/auth/org-route';

interface Opened {
  segment: string;
  organization: string;
}

interface OpenFailure {
  segment: string;
  text: string;
  refused: boolean;
}

interface RoutedOrganization {
  mismatch: boolean;
  failure: OpenFailure | null;
  retry: () => void;
}

export function useRoutedOrganization(wanted: string | null, onLock: () => void): RoutedOrganization {
  const [opened, setOpened] = useState<Opened | null>(null);
  const [failure, setFailure] = useState<OpenFailure | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [, rerender] = useState(0);
  const lock = useRef(onLock);
  useEffect(() => {
    lock.current = onLock;
  }, [onLock]);
  const account = activeAccount();
  const settled = opened !== null && opened.segment === wanted && opened.organization === account?.organization;
  const mismatch = wanted !== null && account !== null && !isCurrentOrganization(wanted, account) && !settled;
  useEffect(() => {
    if (!mismatch) return undefined;
    let alive = true;
    setFailure(null);
    openOrganization(wanted, () => alive)
      .then((outcome) => {
        if (!alive || outcome.kind === 'stale') {
          rerender((n) => n + 1);
          return;
        }
        if (outcome.kind === 'open') setOpened({ segment: wanted, organization: outcome.organization });
        else if (outcome.kind === 'signed-out') lock.current();
        else setFailure({ segment: wanted, text: outcome.message, refused: outcome.kind === 'refused' });
      })
      .catch((err: unknown) => {
        if (alive) setFailure({ segment: wanted, text: err instanceof Error ? err.message : 'Could not open that organization.', refused: false });
      });
    return () => {
      alive = false;
    };
  }, [mismatch, wanted, attempt]);
  const retry = (): void => {
    setFailure(null);
    setAttempt((n) => n + 1);
  };
  return { mismatch, failure: mismatch && failure?.segment === wanted ? failure : null, retry };
}
