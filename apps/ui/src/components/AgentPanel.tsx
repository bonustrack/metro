import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { Button } from '@stage-labs/kit/react-native/button';
import { Card } from '@stage-labs/kit/react-native/card';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { type AccountGroup } from '../api/accounts';
import { type AgentSummary, type CreatedAgent } from '../api/client';
import { AgentDetail } from './AgentDetail';
import { CreateAgent } from './CreateAgent';
import { NewAgentKey } from './NewAgentKey';
import { type Selection } from './selection';

function Hint({ text, onNew }: { text: string; onNew: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Card dark={dark} padding={18}>
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
  endpoint: string;
  selection: Selection;
  created: CreatedAgent | null;
  onCreate: (name: string) => Promise<void>;
  onNew: () => void;
  onDismiss: () => void;
  onChanged: () => void;
  onDelete: (id: number) => Promise<void>;
}

export function AgentPanel(props: AgentPanelProps): ReactNode {
  const { agents, selection, created, onCreate, onDismiss } = props;
  if (selection.kind === 'new')
    return <CreateAgent first={agents.length === 0} onCreate={onCreate} />;

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
            : 'Pick an agent on the left to see its accounts, MCP endpoint and API key.'
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
        endpoint={props.endpoint}
        groups={props.groups}
        attachable={props.attachable}
        unattributed={props.unattributed}
        onChanged={props.onChanged}
        onDelete={props.onDelete}
      />
    </Col>
  );
}
