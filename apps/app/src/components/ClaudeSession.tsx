import { type ReactNode, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckBox } from '@stage-labs/kit/react-native/check-box';
import { Button } from '@stage-labs/kit/react-native/button';
import { controlClaudeSession, type ClaudeSessionStatus } from '@metro-labs/client/api/claude-box';
import { sessionNote } from '@metro-labs/client/api/runner';
import { routeHash } from '@metro-labs/client/route';
import { Group } from './ui/Group.js';
import { Item } from './ui/Item.js';
import { Control } from './settings/rows.js';
import { openTerminal } from '../lib/open-terminal.js';
import { queryError, refresh, useClaudeSessionQuery } from '../lib/queries.js';

const AUTOSTART = 'Starts the agent when the server starts. Stop turns this off, Start turns it back on.';
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

function useClock(on: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => { setNow(Date.now()); }, CLOCK_MS);
    return () => { clearInterval(timer); };
  }, [on]);
  return now;
}

function Rows({ status, project }: { status: ClaudeSessionStatus; project: string }): ReactNode {
  const { send, busy, error } = useSend();
  const now = useClock(status.activity !== null);
  return (
    <>
      <Control title="Status" note={sessionNote(status, now)} error={error}>
        {status.running ? (
          <Button size="sm" color="secondary" label="Stop" disabled={busy} onPress={() => { send({ action: 'stop' }); }} />
        ) : (
          <Button size="sm" color="secondary" label="Start" disabled={busy || status.blocked !== null} onPress={() => { send({ action: 'start' }); }} />
        )}
      </Control>
      <Control title="Start by itself" note={AUTOSTART} inline>
        <CheckBox displayStyle="switch" name="Start by itself" value={status.autostart} disabled={busy} onChange={(on) => { send({ autostart: on }); }} />
      </Control>
      <Item title="Right now" subtitle="What the agent and its workers are doing" href={routeHash({ kind: 'run', project })} />
      <Item title="Conversations" subtitle="Saved turns and tool results" href={routeHash({ kind: 'sessions', project, claudeProject: null, id: null })} />
      {status.running ? <Item title="Terminal" subtitle="The session process and its output" onPress={() => { openTerminal(project); }} /> : null}
    </>
  );
}

export function ClaudeSession({ project }: { project: string }): ReactNode {
  const session = useClaudeSessionQuery({ live: true });
  return (
    <Group label="Session">
      {session.error !== null ? (
        <Control title="Status" error={queryError(session.error, 'Could not read the agent session.')} />
      ) : session.data === undefined ? null : (
        <Rows status={session.data} project={project} />
      )}
    </Group>
  );
}
