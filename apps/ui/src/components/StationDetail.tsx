import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button, Text } from './ui.js';
import { SHRINK } from '../theme.js';
import { PageTitle } from './PageTitle.js';
import { setPolicy, stationLabel } from '../api/attach.js';
import { stationFields, type AccountRow } from '../api/accounts.js';
import { type AgentSummary } from '../api/client.js';
import { queryError } from '../api/queries.js';
import { useAgentName } from '../api/agent-name.js';
import { BackLink } from './BackLink.js';
import { Choice } from './Choice.js';
import { CopyRow } from './CopyRow.js';
import { ConfirmDialog, useConfirm } from './DeleteMenu.js';
import { detachLines } from './DetachAccount.js';
import { CALLBACK_NOTE } from './AttachedAccount.js';
import { routeHash } from '../route.js';
import { StationIcon } from './StationIcon.js';
import { type DetachHandler } from './AccountList.js';
import { Allowlist } from './Allowlist.js';
import { StationName } from './StationName.js';
import { Permissions } from './Permissions.js';
import { FactRow, SettingsGroup, SettingsSection } from './SettingsSection.js';
import { factLabel, factValue } from './channel-facts.js';
import { type GroupedTool } from '../api/policy.js';

const ICON = 32;
const ENDPOINT_NOTE = 'Whoever holds this URL can post to the agent. Paste it straight into the service, never anywhere public.';
const RECEIVE_ON = 'The agent gets the messages written here.';
const RECEIVE_OFF = 'Off. Messages written here do not reach the agent.';
const RECEIVE_ONLY = 'This channel only brings messages in. The agent cannot write here.';

type Toggle = (station: string, accountId: string, enabled: boolean) => Promise<void>;

interface StationDetailProps {
  station: string;
  project: string;
  row: AccountRow;
  agent: AgentSummary | undefined;
  verbs: string[];
  tools: GroupedTool[];
  onDetach?: DetachHandler;
  onAllowlistSaved?: () => Promise<unknown>;
  onToggle?: Toggle;
}

function Header({ station, project, row }: { station: string; project: string; row: AccountRow }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const { handle, url } = stationFields(row);
  const back = routeHash({ kind: 'stations', project });
  return (
    <Col gap={16}>
      <BackLink
        label="Channels"
        href={back}
        onPress={() => {
          window.location.hash = back;
        }}
      />
      <Row justify="between" align="center" gap={16}>
        <Row gap={14} align="center" style={SHRINK}>
          <StationIcon station={station} size={ICON} />
          <Col gap={2} style={SHRINK}>
            <PageTitle>{handle ?? row.id ?? stationLabel(station)}</PageTitle>
            <Text size="sm" role="secondary">
              {`${stationLabel(station)} · ${row.enabled ? 'Receiving' : 'Not receiving'}`}
            </Text>
          </Col>
        </Row>
        {url === undefined ? null : (
          <Button
            size="sm"
            color="secondary"
            dark={dark}
            label={`Open in ${stationLabel(station)}`}
            onPress={() => {
              window.open(url, '_blank', 'noreferrer');
            }}
          />
        )}
      </Row>
    </Col>
  );
}

function NameSetup({ station, id, agentId }: { station: string; id: string | null; agentId: string | undefined }): ReactNode {
  if (station !== 'xmtp' || id === null || agentId === undefined) return null;
  return (
    <div className="settings-pad">
      <StationName agentId={agentId} station={station} accountId={id} />
    </div>
  );
}

function Setup({ station, row, agentId }: { station: string; row: AccountRow; agentId: string | undefined }): ReactNode {
  const { endpoint, callback } = stationFields(row);
  const named = station === 'xmtp' && row.id !== null && agentId !== undefined;
  if (endpoint === undefined && callback === undefined && !named) return null;
  return (
    <SettingsGroup title="Setup">
      {callback === undefined ? null : <CopyRow title="Callback URL" note={CALLBACK_NOTE} value={callback} secret />}
      {endpoint === undefined ? null : <CopyRow title="Webhook URL" note={ENDPOINT_NOTE} value={endpoint} secret />}
      <NameSetup station={station} id={row.id} agentId={agentId} />
    </SettingsGroup>
  );
}

function Details({ station, row }: { station: string; row: AccountRow }): ReactNode {
  const { details } = stationFields(row);
  return (
    <SettingsGroup title="Details">
      {row.id === null ? null : <FactRow label="Channel id" value={row.id} />}
      {row.id === null ? null : <FactRow label="Address for the agent" value={`metro://${station}/${row.id}`} />}
      {details.map((field) => (
        <FactRow key={field.label} label={factLabel(field.label)} value={factValue(field.value)} />
      ))}
    </SettingsGroup>
  );
}

function Receive({ station, id, enabled, onToggle }: { station: string; id: string; enabled: boolean; onToggle: Toggle }): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flip = (next: boolean): void => {
    setBusy(true);
    setError(null);
    onToggle(station, id, next)
      .catch((err: unknown) => {
        setError(queryError(err, next ? 'Could not turn receiving on.' : 'Could not turn receiving off.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <SettingsSection title="Receive messages" note={enabled ? RECEIVE_ON : RECEIVE_OFF}>
      <Choice
        label="Receive messages"
        value={enabled ? 'on' : 'off'}
        options={[
          { value: 'on', label: 'On' },
          { value: 'off', label: 'Off' },
        ]}
        disabled={busy}
        onChange={(value) => {
          flip(value === 'on');
        }}
      />
      {error === null ? null : <Text size="sm" role="danger">{error}</Text>}
    </SettingsSection>
  );
}

function Remove({ station, id, project, onDetach }: { station: string; id: string; project: string; onDetach: DetachHandler }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const confirming = useConfirm(
    () => onDetach(station, id),
    'Could not delete the channel.',
    () => {
      window.location.hash = routeHash({ kind: 'stations', project });
    },
  );
  return (
    <SettingsSection title="Delete channel" note="Removes it from the agent, with the keys Metro keeps for it.">
      <Button size="sm" color="danger" dark={dark} label="Delete" onPress={confirming.show} />
      <ConfirmDialog confirming={confirming} title="Delete channel" lines={detachLines(station)} action="Delete channel" word={id} />
    </SettingsSection>
  );
}

function Manage({ station, project, row, onToggle, onDetach }: { station: string; project: string; row: AccountRow; onToggle?: Toggle; onDetach?: DetachHandler }): ReactNode {
  const id = row.id;
  if (id === null || (onToggle === undefined && onDetach === undefined)) return null;
  return (
    <SettingsGroup title="Manage">
      {onToggle === undefined ? null : <Receive station={station} id={id} enabled={row.enabled} onToggle={onToggle} />}
      {onDetach === undefined ? null : <Remove station={station} id={id} project={project} onDetach={onDetach} />}
    </SettingsGroup>
  );
}

function Abilities({ station, row, agent, verbs, tools, onSaved }: { station: string; row: AccountRow; agent: AgentSummary | undefined; verbs: string[]; tools: GroupedTool[]; onSaved?: () => Promise<unknown> }): ReactNode {
  const title = `What ${useAgentName()} may do here`;
  const id = row.id;
  if (verbs.length === 0)
    return (
      <SettingsGroup title={title}>
        <div className="settings-pad">
          <Text size="sm" role="secondary">{RECEIVE_ONLY}</Text>
        </div>
      </SettingsGroup>
    );
  if (id === null || agent === undefined || onSaved === undefined || tools.length === 0) return null;
  return <Permissions title={title} policy={row.policy} tools={tools} store={(next) => setPolicy(agent.id, station, id, next)} onSaved={onSaved} />;
}

export function StationDetail({ station, project, row, agent, verbs, tools, onDetach, onAllowlistSaved, onToggle }: StationDetailProps): ReactNode {
  const id = row.id;
  const name = useAgentName();
  return (
    <Col gap={32}>
      <Header station={station} project={project} row={row} />
      {id === null || agent === undefined || onAllowlistSaved === undefined || row.allowlist === null ? null : (
        <Allowlist
          title={`Who can write to ${name}`}
          agentId={agent.id}
          station={station}
          accountId={id}
          allowlist={row.allowlist}
          approvers={row.approvers}
          onSaved={onAllowlistSaved}
        />
      )}
      <Abilities station={station} row={row} agent={agent} verbs={verbs} tools={tools} onSaved={onAllowlistSaved} />
      <Setup station={station} row={row} agentId={agent?.id} />
      <Details station={station} row={row} />
      <Manage station={station} project={project} row={row} onToggle={onToggle} onDetach={onDetach} />
    </Col>
  );
}
