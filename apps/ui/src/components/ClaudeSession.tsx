import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { controlClaudeSession, type ClaudeSessionStatus } from '../api/claude-box.js';
import { queryError, refreshClaudeSession, useClaudeSessionQuery } from '../api/queries.js';
import { routeHash } from '../route.js';
import { useQueryClient } from '@tanstack/react-query';

const WHAT = 'The daemon keeps a Claude Code session running in tmux, and starts it once a model is connected.';

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
  const session = useClaudeSessionQuery();
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
