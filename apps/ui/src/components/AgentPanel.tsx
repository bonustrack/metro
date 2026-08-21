import { type ReactNode } from 'react';
import { AgentPage } from './AgentPage';
import { AgentsHome } from './AgentsHome';
import { deleteConnector } from '../api/connectors';
import { ConnectorPage } from './ConnectorPage';
import { Connectors } from './Connectors';
import { Docs } from './Docs';
import { Settings } from './Settings';
import { StationPage } from './StationPage';
import { type Selection } from './selection';

interface AgentPanelProps {
  token: string;
  selection: Selection;
  onSelect: (selection: Selection) => void;
}

export function AgentPanel({
  token,
  selection,
  onSelect,
}: AgentPanelProps): ReactNode {
  if (selection.kind === 'docs') return <Docs />;
  if (selection.kind === 'settings') return <Settings />;
  if (selection.kind === 'connectors')
    return (
      <Connectors
        token={token}
        onOpen={(id) => {
          onSelect({ kind: 'connector', id });
        }}
      />
    );
  if (selection.kind === 'connector')
    return (
      <ConnectorPage
        token={token}
        id={selection.id}
        onDelete={async (id) => {
          await deleteConnector(token, id);
          onSelect({ kind: 'connectors' });
        }}
        onBack={() => {
          onSelect({ kind: 'connectors' });
        }}
      />
    );
  if (selection.kind === 'station')
    return (
      <StationPage
        token={token}
        accountId={selection.accountId}
        onOpenAgent={(id) => {
          onSelect({ kind: 'agent', id });
        }}
      />
    );
  if (selection.kind === 'agent')
    return (
      <AgentPage
        token={token}
        id={selection.id}
        onOpenStation={(accountId) => {
          onSelect({ kind: 'station', accountId });
        }}
        onGone={() => {
          onSelect({ kind: 'none' });
        }}
        onBack={() => {
          onSelect({ kind: 'none' });
        }}
      />
    );
  return (
    <AgentsHome
      token={token}
      onOpen={(id) => {
        onSelect({ kind: 'agent', id });
      }}
    />
  );
}
