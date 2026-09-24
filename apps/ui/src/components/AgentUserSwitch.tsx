import { type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { ConfirmDialog, useConfirm } from './DeleteMenu.js';
import { AGENT_USER_SINCE, switchAgentUser, type AgentUserStatus } from '../api/agent-user.js';
import { queryError, refresh, useAgentUserQuery, useModeQuery } from '../api/queries.js';
import { olderThan } from '../api/version.js';

const ABOUT = 'Claude Code runs as the user agent instead of root, so it cannot read the channel keys on this machine.';

const ON_LINES = [
  'Metro creates the user agent, moves Claude Code, its login, sessions and memory to it, and restarts.',
  'The agent can no longer read the channel keys, install system packages or use systemctl. The Terminal opens the agent\'s shell.',
];
const OFF_LINES = [
  'Claude Code runs as root again, from the copy of its folder root kept when this was switched on. Newer sessions and memory stay with the user agent.',
];

function stateText(status: AgentUserStatus): string {
  if (!status.enabled) return 'Off: Claude Code runs as root.';
  return status.active ? `On: Claude Code runs as ${status.user ?? 'agent'}.` : 'On, but the user is not ready yet. See the Claude session above.';
}

function Switch({ status }: { status: AgentUserStatus }): ReactNode {
  const client = useQueryClient();
  const dark = useKitScheme() === 'dark';
  const turningOn = !status.enabled;
  const confirming = useConfirm(
    () => switchAgentUser(turningOn).then(() => refresh(client, 'agent-user')),
    'Could not switch it.',
  );
  return (
    <Col gap={8}>
      <Text size="sm">{stateText(status)}</Text>
      {status.supported || status.enabled ? (
        <Row>
          <Button size="sm" color="secondary" dark={dark} label={turningOn ? 'Switch on' : 'Switch off'} onPress={confirming.show} />
        </Row>
      ) : (
        <Text size="sm" role="secondary">{status.reason ?? 'Not available on this machine.'}</Text>
      )}
      <ConfirmDialog
        confirming={confirming}
        title={turningOn ? 'Run Claude Code as its own user?' : 'Run Claude Code as root again?'}
        lines={turningOn ? ON_LINES : OFF_LINES}
        action={turningOn ? 'Switch on' : 'Switch off'}
        word="switch"
      />
    </Col>
  );
}

export function AgentUserSwitch(): ReactNode {
  const mode = useModeQuery();
  const supported = mode.data !== undefined && !olderThan(mode.data.version, AGENT_USER_SINCE);
  const status = useAgentUserQuery(supported);
  if (mode.data === undefined) return null;
  return (
    <Col gap={8}>
      <Text size="md" weight="semibold">Separate user</Text>
      <Text size="sm" role="secondary">{ABOUT}</Text>
      {!supported ? (
        <Text size="sm" role="secondary">{`Needs metro ${AGENT_USER_SINCE}. Update first, from the Server page.`}</Text>
      ) : status.error !== null ? (
        <Text size="sm" role="danger">{queryError(status.error, 'Could not read it.')}</Text>
      ) : status.data === undefined ? null : (
        <Switch status={status.data} />
      )}
    </Col>
  );
}
