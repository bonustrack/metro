import { type ReactNode, useState } from 'react';
import { type AgentSummary } from '../api/client';
import { ConfirmModal } from './ConfirmModal';
import { KebabMenu } from './KebabMenu';

interface ResetAgentKeyProps {
  agent: AgentSummary;
  onReset: (id: number) => Promise<void>;
}

const CONFIRM_WORD = 'DELETE';

const CONSEQUENCES = [
  'The current API key stops working immediately, everywhere.',
  'Any “claude mcp add” registration using it must be redone with the new command.',
  'A connected MCP session for this agent is disconnected and has to reconnect.',
  'Attachment links are not affected. Each one carries its own token.',
];

export function ResetAgentKey({ agent, onReset }: ResetAgentKeyProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      <KebabMenu
        label="Key actions"
        items={[
          {
            label: 'Reset API key',
            danger: true,
            onSelect: () => {
              setError(null);
              setOpen(true);
            },
          },
        ]}
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
