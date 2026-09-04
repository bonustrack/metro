import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';
import { queryError, useModeQuery, useUpdateQuery } from '../api/queries';
import { fetchMode } from '../api/mode';
import { runUpdate } from '../api/update';

const POLL_MS = 3_000;
const POLL_MAX_MS = 4 * 60_000;

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function untilVersion(version: string): Promise<void> {
  const until = Date.now() + POLL_MAX_MS;
  while (Date.now() < until) {
    await wait(POLL_MS);
    const mode = await fetchMode().catch(() => null);
    if (mode?.version === version) return;
  }
  throw new Error(`The daemon did not come back on ${version} yet. Check the machine.`);
}

type Phase = { kind: 'idle' } | { kind: 'updating'; to: string } | { kind: 'done'; to: string };

export function MetroVersion({ token }: { token: string }): ReactNode {
  const client = useQueryClient();
  const dark = useKitScheme() === 'dark';
  const mode = useModeQuery();
  const check = useUpdateQuery(token);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const version = mode.data?.version ?? null;
  if (version === null) return null;

  const update = (): void => {
    const to = check.data?.latest ?? '';
    setPhase({ kind: 'updating', to });
    setError(null);
    runUpdate(token)
      .then(async (result) => {
        if (result.restarting) await untilVersion(result.version);
        setPhase({ kind: 'done', to: result.version });
        await client.invalidateQueries();
      })
      .catch((err: unknown) => {
        setPhase({ kind: 'idle' });
        setError(queryError(err, 'Could not update metro.'));
      });
  };

  return (
    <Row gap={10} align="center" wrap>
      <Text size="sm" role="secondary">
        metro {version}
      </Text>
      {phase.kind === 'updating' ? (
        <Text size="sm" role="secondary">
          Updating to {phase.to}, the daemon restarts…
        </Text>
      ) : phase.kind === 'done' ? (
        <Text size="sm" role="secondary">
          Updated to {phase.to}.
        </Text>
      ) : check.data?.newer === true ? (
        <Button size="sm" color="secondary" dark={dark} label={`Update to ${check.data.latest}`} onPress={update} />
      ) : check.data !== undefined ? (
        <Text size="sm" role="secondary">
          up to date
        </Text>
      ) : null}
      {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
    </Row>
  );
}
