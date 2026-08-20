import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Card } from '@stage-labs/kit/react-native/card';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';
import { CARD_PADDING } from '../theme';
import { type AccountGroup } from '../api/accounts';
import { type AgentSummary, type CreatedAgent } from '../api/client';
import { AgentDetail } from './AgentDetail';
import { AgentsHome } from './AgentsHome';
import { NewAgentKey } from './NewAgentKey';
import { Docs } from './Docs';
import { Settings } from './Settings';
import { type Selection } from './selection';

function Hint({ text, onNew }: { text: string; onNew: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Card dark={dark} padding={CARD_PADDING}>
      <Col gap={12} align="start">
        <Text role="secondary">{text}</Text>
        <Button size="sm" color="primary" dark={dark} label="New agent" onPress={onNew} />
      </Col>
    </Card>
  );
}

interface AgentPanelProps {
  token: string;
  agents: AgentSummary[];
  groups: AccountGroup[];
  attachable: string[];
  unattributed: number;
  selection: Selection;
  created: CreatedAgent | null;
  onNew: () => void;
  onOpen: (id: number) => void;
  onDismiss: () => void;
  onChanged: (dropped?: string[]) => void;
  onDelete: (id: number) => Promise<void>;
}

function standalonePage(props: AgentPanelProps): ReactNode | null {
  const { agents, selection, created } = props;
  if (selection.kind === 'docs') return <Docs />;
  if (selection.kind === 'settings') return <Settings />;
  if (selection.kind === 'none' && created === null)
    return (
      <AgentsHome
        agents={agents}
        groups={props.groups}
        onOpen={props.onOpen}
        onNew={props.onNew}
      />
    );
  return null;
}

export function AgentPanel(props: AgentPanelProps): ReactNode {
  const standalone = standalonePage(props);
  if (standalone !== null) return standalone;
  const { agents, selection, created, onDismiss } = props;

  const agent =
    selection.kind === 'agent'
      ? agents.find((a) => a.id === selection.id)
      : undefined;

  if (agent === undefined) {
    if (created !== null) return <NewAgentKey created={created} onDismiss={onDismiss} />;
    return (
      <Hint
        text={
          selection.kind === 'agent'
            ? 'No agent with that id is available to this account.'
            : 'Pick an agent on the left to see its stations, MCP endpoint and API key.'
        }
        onNew={props.onNew}
      />
    );
  }

  return (
    <Col gap={16}>
      {created !== null && created.id === agent.id ? (
        <NewAgentKey created={created} onDismiss={onDismiss} />
      ) : null}
      <AgentDetail
        token={props.token}
        agent={agent}
        groups={props.groups}
        attachable={props.attachable}
        unattributed={props.unattributed}
        onChanged={props.onChanged}
        onDelete={props.onDelete}
      />
    </Col>
  );
}
