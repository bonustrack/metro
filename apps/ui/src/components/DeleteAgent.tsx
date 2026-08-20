import { type ReactNode, useState } from 'react';
import { type AgentSummary } from '../api/client';
import { ConfirmModal } from './ConfirmModal';
import { KebabMenu } from './KebabMenu';

interface DeleteAgentProps {
  agent: AgentSummary;
  onDelete: (id: number) => Promise<void>;
}

export function DeleteAgent({ agent, onDelete }: DeleteAgentProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = (): void => {
    setBusy(true);
    setError(null);
    onDelete(agent.id).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Could not delete the agent.');
      setBusy(false);
    });
  };

  return (
    <>
      <KebabMenu
        label="Agent actions"
        size="lg"
        items={[
          {
            label: 'Delete agent',
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
        title="Delete agent"
        lines={[
          `Deleting “${agent.name}” cannot be undone. Its API key stops working immediately, everywhere.`,
          'Delete its stations first if it still has any.',
        ]}
        prompt={`Type ${agent.name} to confirm.`}
        confirmWord={agent.name}
        confirmLabel="Delete agent"
        busy={busy}
        error={error}
        onClose={() => {
          setOpen(false);
        }}
        onConfirm={remove}
      />
    </>
  );
}
