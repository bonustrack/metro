import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { updateClaudeCode, type ClaudeVersion as Version } from '../api/claude-box.js';
import { queryError, refreshClaudeSession, refreshClaudeVersion, useClaudeVersionQuery } from '../api/queries.js';

type Phase = { kind: 'idle' } | { kind: 'updating'; to: string } | { kind: 'done'; to: string; restarted: boolean };

function Status({ phase, check, onUpdate }: { phase: Phase; check: Version; onUpdate: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  if (phase.kind === 'updating') return <Text size="sm" role="secondary">{`Updating to ${phase.to}…`}</Text>;
  if (phase.kind === 'done')
    return <Text size="sm" role="secondary">{phase.restarted ? `Updated to ${phase.to}. The session restarts on the new build.` : `Updated to ${phase.to}.`}</Text>;
  if (check.newer && check.latest !== null) return <Button size="sm" color="secondary" dark={dark} label={`Update to ${check.latest}`} onPress={onUpdate} />;
  if (check.installed !== null && check.latest !== null) return <Text size="sm" role="secondary">up to date</Text>;
  return null;
}

export function ClaudeVersion(): ReactNode {
  const client = useQueryClient();
  const check = useClaudeVersionQuery();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  if (check.data === undefined) return null;
  const installed = check.data.installed;

  const update = (): void => {
    setPhase({ kind: 'updating', to: check.data?.latest ?? '' });
    setError(null);
    updateClaudeCode()
      .then(async (result) => {
        setPhase({ kind: 'done', to: result.installed ?? '', restarted: result.restarted });
        await refreshClaudeVersion(client);
        await refreshClaudeSession(client);
      })
      .catch((err: unknown) => {
        setPhase({ kind: 'idle' });
        setError(queryError(err, 'Could not update Claude Code.'));
      });
  };

  return (
    <Row gap={10} align="center" wrap>
      <Text size="sm" role="secondary">
        {installed === null ? 'Claude Code is not installed on this machine' : `Claude Code ${installed}`}
      </Text>
      <Status phase={phase} check={check.data} onUpdate={update} />
      {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
    </Row>
  );
}
