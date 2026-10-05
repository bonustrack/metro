import { type ReactNode, useEffect, useState } from 'react';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { Choice } from './Choice.js';
import { SettingsSection } from './SettingsSection.js';
import { TextLink } from './TextLink.js';
import { controlClaudeSession, type ClaudeSessionStatus } from '@metro-labs/client/api/claude-box';
import { sessionNote } from '@metro-labs/client/api/runner';
import { RunnerActivity } from './RunnerActivity.js';
import { queryError, refresh, useClaudeSessionQuery } from '../lib/queries.js';
import { routeHash } from '@metro-labs/client/route';
import { useQueryClient } from '@tanstack/react-query';

const AUTOSTART = 'Starts the agent by itself when the server starts. Stop cancels active work and turns this off. Start runs the agent and enables automatic starts again.';
const CLOCK_MS = 1_000;

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

function Rows({ status, project, live }: { status: ClaudeSessionStatus; project: string; live: boolean }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const { send, busy, error } = useSend();
  const [now, setNow] = useState(Date.now);
  const hasActivity = status.activity !== null;
  useEffect(() => {
    if (!hasActivity) return;
    setNow(Date.now());
    const timer = setInterval(() => { setNow(Date.now()); }, CLOCK_MS);
    return () => { clearInterval(timer); };
  }, [hasActivity]);
  return (
    <>
      <SettingsSection title="Status" note={sessionNote(status, now)}>
        {status.running ? (
          <Button size="md" color="secondary" dark={dark} label="Stop" disabled={busy} onPress={() => { send({ action: 'stop' }); }} />
        ) : (
          <Button size="md" color="secondary" dark={dark} label="Start" disabled={busy || status.blocked !== null} onPress={() => { send({ action: 'start' }); }} />
        )}
        {error === null ? null : <Text size="2xs" role="danger">{error}</Text>}
      </SettingsSection>
      {status.running && status.runner !== null ? (
        <SettingsSection title="Running runner">
          <Text size="2xs" role="secondary">{status.runner === 'sdk' ? 'Agent SDK' : 'Claude Code'}</Text>
        </SettingsSection>
      ) : null}
      <RunnerActivity status={status} now={now} live={live} />
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
      <SettingsSection title="Conversations" note="Read saved turns and tool results. Each runner keeps its own conversation.">
        <TextLink to={routeHash({ kind: 'sessions', project, claudeProject: null, id: null })}>Open Conversations</TextLink>
      </SettingsSection>
      {status.running ? (
        <SettingsSection title="Terminal" note="Inspect the session process and its output.">
          <TextLink to={routeHash({ kind: 'terminal', project })}>Open Terminal</TextLink>
        </SettingsSection>
      ) : null}
    </>
  );
}

export function ClaudeSession({ project, live = false }: { project: string; live?: boolean }): ReactNode {
  const session = useClaudeSessionQuery({ live });
  if (session.error !== null)
    return (
      <SettingsSection title="Status" note={queryError(session.error, 'Could not read the agent session.')}>
        {null}
      </SettingsSection>
    );
  if (session.data === undefined) return null;
  return <Rows status={session.data} project={project} live={live} />;
}
