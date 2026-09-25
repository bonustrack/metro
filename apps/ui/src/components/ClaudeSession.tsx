import { type ReactNode, useState } from 'react';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { Choice } from './Choice.js';
import { SettingsSection } from './SettingsSection.js';
import { controlClaudeSession, type ClaudeSessionStatus } from '../api/claude-box.js';
import { queryError, refresh, useClaudeSessionQuery } from '../api/queries.js';
import { routeHash } from '../route.js';
import { useQueryClient } from '@tanstack/react-query';

const AUTOSTART = 'Starts the agent by itself when the server starts.';
const TERMINAL = 'Watch the agent work, live, in a new tab.';

function statusLine(status: ClaudeSessionStatus): string {
  if (status.running) return 'Running.';
  if (status.lastError !== null) return `Not running: ${status.lastError}`;
  if (status.blocked !== null) return `Waiting: ${status.blocked}.`;
  return status.autostart ? 'Starting in a few seconds.' : 'Not running.';
}

type Send = (input: { action?: 'start' | 'stop'; autostart?: boolean }) => void;

function useSend(): { send: Send; busy: boolean; error: string | null } {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send: Send = (input) => {
    setBusy(true);
    setError(null);
    controlClaudeSession(input)
      .then(() => refresh(client, 'claude-session'))
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not change the agent session.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return { send, busy, error };
}

function Rows({ status, project }: { status: ClaudeSessionStatus; project: string }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const { send, busy, error } = useSend();
  return (
    <>
      <SettingsSection title="Status" note={statusLine(status)}>
        {status.running ? (
          <Button size="sm" color="secondary" dark={dark} label="Stop" disabled={busy} onPress={() => { send({ action: 'stop' }); }} />
        ) : (
          <Button size="sm" color="secondary" dark={dark} label="Start" disabled={busy || status.blocked !== null} onPress={() => { send({ action: 'start' }); }} />
        )}
        {error === null ? null : <Text size="sm" role="danger">{error}</Text>}
      </SettingsSection>
      <SettingsSection title="Start by itself" note={AUTOSTART}>
        <Choice
          label="Start by itself"
          value={status.autostart ? 'on' : 'off'}
          options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]}
          disabled={busy}
          onChange={(value) => {
            send({ autostart: value === 'on' });
          }}
        />
      </SettingsSection>
      {status.running ? (
        <SettingsSection title="Terminal" note={TERMINAL}>
          <Button
            size="sm"
            color="secondary"
            dark={dark}
            label="Open"
            onPress={() => {
              window.open(routeHash({ kind: 'terminal', project }), '_blank', 'noopener');
            }}
          />
        </SettingsSection>
      ) : null}
    </>
  );
}

export function ClaudeSession({ project }: { project: string }): ReactNode {
  const session = useClaudeSessionQuery();
  if (session.error !== null)
    return (
      <SettingsSection title="Status" note={queryError(session.error, 'Could not read the agent session.')}>
        {null}
      </SettingsSection>
    );
  if (session.data === undefined) return null;
  return <Rows status={session.data} project={project} />;
}
