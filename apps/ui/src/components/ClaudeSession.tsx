import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { controlClaudeSession, type ClaudeSessionStatus } from '../api/claude-box.js';
import { queryError, refreshClaudeSession, useClaudeSessionQuery, useModeQuery } from '../api/queries.js';
import { olderThan } from '../api/version.js';
import { routeHash } from '../route.js';
import { useQueryClient } from '@tanstack/react-query';

const SESSION_SINCE = '0.1.0-beta.103';
const WHAT =
  'The daemon keeps a Claude Code session running in tmux with the metro channel loaded, started by itself once this machine has an agent and a credential: a sign-in on the Model page, or another provider chosen there. Open it in the Terminal tab.';

function statusLine(status: ClaudeSessionStatus): string {
  if (status.running) return `Running in tmux session "${status.name}".`;
  if (status.lastError !== null) return `Not running: ${status.lastError}`;
  if (status.blocked !== null) return `Waiting: ${status.blocked}.`;
  return status.autostart ? 'Not running yet; the daemon starts it within a few seconds.' : 'Not running.';
}

function Controls({ status, project }: { status: ClaudeSessionStatus; project: string }): ReactNode {
  const client = useQueryClient();
  const dark = useKitScheme() === 'dark';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = (input: { action?: 'start' | 'stop'; autostart?: boolean }): void => {
    setBusy(true);
    setError(null);
    controlClaudeSession(input)
      .then(() => refreshClaudeSession(client))
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not change the Claude session.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <Col gap={8}>
      <Row gap={10} align="center" wrap>
        {status.running ? (
          <Button size="sm" color="secondary" dark={dark} label="Stop" disabled={busy} onPress={() => { send({ action: 'stop' }); }} />
        ) : (
          <Button size="sm" color="secondary" dark={dark} label="Start now" disabled={busy || status.blocked !== null} onPress={() => { send({ action: 'start' }); }} />
        )}
        <Button
          size="sm"
          color="secondary"
          dark={dark}
          label={status.autostart ? 'Auto-start: on' : 'Auto-start: off'}
          disabled={busy}
          onPress={() => {
            send({ autostart: !status.autostart });
          }}
        />
        {status.running ? (
          <Text size="sm" role="secondary">
            <a className="hint-link" href={routeHash({ kind: 'terminal', project })}>Open the terminal</a>
          </Text>
        ) : null}
      </Row>
      {error === null ? null : (
        <Text size="sm" role="danger">{error}</Text>
      )}
    </Col>
  );
}

export function ClaudeSession({ project }: { project: string }): ReactNode {
  const mode = useModeQuery();
  const session = useClaudeSessionQuery();
  if (olderThan(mode.data?.version ?? null, SESSION_SINCE))
    return (
      <Col gap={4}>
        <Text size="md" weight="semibold">Claude session</Text>
        <Text size="sm" role="secondary">A daemon-run Claude session needs metro {SESSION_SINCE} or newer on the machine. Update first.</Text>
      </Col>
    );
  return (
    <Col gap={8}>
      <Text size="md" weight="semibold">Claude session</Text>
      <Text size="sm" role="secondary">{WHAT}</Text>
      {session.error !== null ? (
        <Text size="sm" role="danger">{queryError(session.error, 'Could not read the Claude session.')}</Text>
      ) : session.data === undefined ? null : (
        <Col gap={8}>
          <Text size="sm">{statusLine(session.data)}</Text>
          <Controls status={session.data} project={project} />
        </Col>
      )}
    </Col>
  );
}
