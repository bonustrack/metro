import { type ReactNode, useState } from 'react';
import { type AgentSummary } from '../api/client.js';
import { ConfirmModal } from './ConfirmModal.js';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from './ui.js';

interface ResetAgentKeyProps {
  agent: AgentSummary;
  onReset: (id: string) => Promise<void>;
}

const CONFIRM_WORD = 'DELETE';

const CONSEQUENCES = [
  'The current API key stops working immediately: MCP, the connector relay and the model gateway all refuse it.',
  'The Claude session on this machine restarts with the new key and resumes the same conversation.',
  'Attachment links are not affected. Each one carries its own token.',
];

export function ResetAgentKey({ agent, onReset }: ResetAgentKeyProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dark = useKitScheme() === 'dark';

  const reset = (): void => {
    setBusy(true);
    setError(null);
    onReset(agent.id).then(
      () => {
        setBusy(false);
        setOpen(false);
      },
      (err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not reset the key.');
        setBusy(false);
      },
    );
  };

  return (
    <>
      <Button
        color="secondary"
        dark={dark}
        label="Reset API key"
        onPress={() => {
          setError(null);
          setOpen(true);
        }}
      />
      <ConfirmModal
        open={open}
        title="Reset API key"
        lines={CONSEQUENCES}
        prompt={`Type ${CONFIRM_WORD} to confirm.`}
        confirmWord={CONFIRM_WORD}
        confirmLabel="Reset API key"
        busy={busy}
        error={error}
        onClose={() => {
          setOpen(false);
        }}
        onConfirm={reset}
      />
    </>
  );
}
