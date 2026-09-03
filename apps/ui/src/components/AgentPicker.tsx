import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Checkbox } from '@stage-labs/kit/react-native/checkbox';
import { Pressable } from '@stage-labs/kit/react-native/pressable';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { useQueryClient } from '@tanstack/react-query';
import { Text, Button } from './ui';
import { SHRINK } from '../theme';
import { Modal } from './Modal';
import { Loading } from './Loading';
import { AgentAvatar } from './AgentAvatar';
import {
  addAgentConnector,
  removeAgentConnector,
} from '../api/agent-connectors';
import { type AgentSummary } from '../api/client';
import { queryError, refreshAgents, useAgentsQuery } from '../api/queries';

const AVATAR_SIZE = 16;
const EMPTY = 'No agents yet. Create one from the Agents page first.';

function PickerRow({
  agent,
  checked,
  busy,
  onToggle,
}: {
  agent: AgentSummary;
  checked: boolean;
  busy: boolean;
  onToggle: () => void;
}): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Row gap={10} align="center">
      <Checkbox
        name={`agent-${agent.id}`}
        checked={checked}
        disabled={busy}
        dark={dark}
        onChange={onToggle}
      />
      <Pressable
        pressedOpacity={0.6}
        disabled={busy}
        onPress={onToggle}
        style={SHRINK}
      >
        <Row gap={8} align="center" minWidth={0}>
          <AgentAvatar seed={agent.id} size={AVATAR_SIZE} />
          <Text size="md" numberOfLines={1}>
            {agent.name}
          </Text>
        </Row>
      </Pressable>
    </Row>
  );
}

function PickerBody({
  agents,
  loading,
  error,
  failed,
  chosen,
  busy,
  onToggle,
}: {
  agents: AgentSummary[];
  loading: boolean;
  error: unknown;
  failed: string | null;
  chosen: string[];
  busy: boolean;
  onToggle: (id: string) => void;
}): ReactNode {
  return (
    <>
      {error === null ? null : (
        <Text size="sm" role="danger">
          {queryError(error, 'Could not load your agents.')}
        </Text>
      )}
      {failed === null ? null : (
        <Text size="sm" role="danger">
          {failed}
        </Text>
      )}
      {loading ? <Loading /> : null}
      {!loading && error === null && agents.length === 0 ? (
        <Text size="sm" role="secondary">
          {EMPTY}
        </Text>
      ) : null}
      <Col gap={10}>
        {agents.map((agent) => (
          <PickerRow
            key={agent.id}
            agent={agent}
            checked={chosen.includes(agent.id)}
            busy={busy}
            onToggle={() => {
              onToggle(agent.id);
            }}
          />
        ))}
      </Col>
    </>
  );
}

interface AgentPickerProps {
  token: string;
  project: string;
  connectorId: string;
  connectorName: string;
  open: boolean;
  onClose: () => void;
}

const holders = (agents: AgentSummary[], connectorId: string): string[] =>
  agents.filter((a) => a.connectorIds.includes(connectorId)).map((a) => a.id);

export function AgentPicker({
  token,
  project,
  connectorId,
  connectorName,
  open,
  onClose,
}: AgentPickerProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const client = useQueryClient();
  const { data, error } = useAgentsQuery(token, project);
  const [staged, setStaged] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const agents = data?.agents ?? [];
  const saved = holders(agents, connectorId);
  const chosen = staged ?? saved;

  const close = (): void => {
    setStaged(null);
    setFailed(null);
    onClose();
  };

  const toggle = (id: string): void => {
    setStaged(
      chosen.includes(id) ? chosen.filter((c) => c !== id) : [...chosen, id],
    );
  };

  const save = (): void => {
    if (busy) return;
    const added = chosen.filter((id) => !saved.includes(id));
    const dropped = saved.filter((id) => !chosen.includes(id));
    if (added.length === 0 && dropped.length === 0) {
      close();
      return;
    }
    setBusy(true);
    setFailed(null);
    Promise.all([
      ...added.map((id) => addAgentConnector(token, id, connectorId)),
      ...dropped.map((id) => removeAgentConnector(token, id, connectorId)),
    ])
      .then(() => {
        refreshAgents(client, project);
        close();
      })
      .catch((err: unknown) => {
        setFailed(queryError(err, 'Could not save that.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Modal title={`Add ${connectorName} to an agent`} open={open} onClose={close}>
      <Col gap={12}>
        <PickerBody
          agents={agents}
          loading={data === undefined && error === null}
          error={error}
          failed={failed}
          chosen={chosen}
          busy={busy}
          onToggle={toggle}
        />
        <Row justify="between" align="center" gap={12} wrap>
          <Button
            color="secondary"
            dark={dark}
            disabled={busy}
            label="Cancel"
            onPress={close}
          />
          <Button
            color="primary"
            dark={dark}
            loading={busy}
            disabled={busy}
            label="Save"
            onPress={save}
          />
        </Row>
      </Col>
    </Modal>
  );
}
