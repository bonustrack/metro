import { type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button, Text } from './ui.js';
import { ConfirmDialog, useConfirm } from './DeleteMenu.js';
import { fetchMetroUser, METRO_USER_SINCE, startMetroUserMove, type MetroUser as State } from '../api/metro-user.js';
import { refresh, useBoxQuery, useModeQuery } from '../api/queries.js';
import { olderThan } from '../api/version.js';

const ROOT_NOTE =
  'Metro runs as root. Moving it to its own user means a bug in Metro can no longer take over the whole machine: Metro gets only the few root actions it needs, through a small checked helper.';
const METRO_NOTE = 'Metro runs as its own user, metro. It reaches root only through its checked helper.';
const MOVE_LINES = [
  'Metro stops for a minute, moves its files from /root/.metro to /var/lib/metro, and starts again as the user metro. The channels reconnect by themselves; the Claude session keeps running.',
  'If Metro does not come back healthy, the move puts everything back as root by itself.',
];

const moving = (s: State): boolean => s.move === 'starting' || s.move === 'moving';

function Status({ state }: { state: State }): ReactNode {
  if (moving(state)) return <Text size="sm" role="secondary">Moving… this page reconnects when Metro is back.</Text>;
  if (state.move === 'failed') return <Text size="sm" role="danger">The last move did not work and was undone. The box runs as before.</Text>;
  if (state.runningAs === 'metro' && !state.helperCurrent) return <Text size="sm" role="danger">The root helper on this box is older than this Metro, so a few root actions may fail. Updating it needs a root shell on the box.</Text>;
  return null;
}

function MoveButton({ state }: { state: State }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const client = useQueryClient();
  const confirming = useConfirm(
    async () => {
      await startMetroUserMove();
      await refresh(client, 'metro-user');
    },
    'Could not start the move.',
  );
  if (!state.canMove || moving(state)) return null;
  return (
    <>
      <Row>
        <Button dark={dark} label="Run Metro as its own user" onPress={confirming.show} />
      </Row>
      <ConfirmDialog confirming={confirming} title="Run Metro as its own user?" lines={MOVE_LINES} action="Move" word="move" />
    </>
  );
}

function Body(): ReactNode {
  const query = useBoxQuery('metro-user', fetchMetroUser, { refetchInterval: (q) => (q.state.data !== undefined && moving(q.state.data) ? 3000 : 30_000), retry: true });
  const state = query.data;
  if (state === undefined || state.runningAs === 'other') return null;
  return (
    <Col gap={8}>
      <Text size="lg" weight="semibold">Metro's own user</Text>
      <Text size="sm" role="secondary">{state.runningAs === 'metro' ? METRO_NOTE : ROOT_NOTE}</Text>
      <Status state={state} />
      <MoveButton state={state} />
    </Col>
  );
}

export function MetroUser(): ReactNode {
  const mode = useModeQuery();
  if (mode.data === undefined || olderThan(mode.data.version, METRO_USER_SINCE)) return null;
  return <Body />;
}
