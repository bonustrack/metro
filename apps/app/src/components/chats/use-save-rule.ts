import { useRef, useState } from 'react';
import { setPolicy } from '@metro-labs/client/api/attach';
import { type ChannelProps } from './channel-props.js';
import { withChoice, type RuleChoice, type RuleTarget } from '../../lib/channel-rules.js';
import { queryError } from '../../lib/queries.js';

const SAVE_FAILED = 'Could not save the rule.';

export interface SaveRule {
  busy: boolean;
  error: string | null;
  pick: (target: RuleTarget, choice: RuleChoice) => void;
}

export function useSaveRule({ agentId, found, view, onSaved }: Pick<ChannelProps, 'agentId' | 'found' | 'view' | 'onSaved'>): SaveRule {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const { station, row } = found;
  const pick = (target: RuleTarget, choice: RuleChoice): void => {
    const id = row.id;
    if (pending.current || id === null) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setPolicy(agentId, station, id, withChoice(row.policy, view.tools[station] ?? [], target, choice))
      .then(() => onSaved())
      .catch((err: unknown) => {
        setError(queryError(err, SAVE_FAILED));
      })
      .finally(() => {
        pending.current = false;
        setBusy(false);
      });
  };
  return { busy, error, pick };
}
