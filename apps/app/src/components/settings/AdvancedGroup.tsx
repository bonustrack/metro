import { type ReactNode } from 'react';
import { serverLabel, type Server } from '@metro-labs/client/api/servers';
import { routeHash } from '@metro-labs/client/route';
import { Group } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { useClaudeSetupQuery, useStationsQuery } from '../../lib/queries.js';
import { modeName, promptKind } from '../../lib/settings-values.js';
import { useTechnicalDetails } from '../../lib/technical.js';
import { openTerminal } from '../../lib/open-terminal.js';

function SetupRow({ href }: { href: string }): ReactNode {
  const technical = useTechnicalDetails();
  const setup = useClaudeSetupQuery().data;
  const detail = technical && setup !== undefined ? `${modeName(setup.permissionMode)} · ${promptKind(setup.systemPrompt)}` : 'Permissions and system prompt';
  return <Item title="Agent SDK setup" subtitle={detail} href={href} />;
}

export function AdvancedGroup({ server, project }: { server: Server; project: string }): ReactNode {
  const agent = useStationsQuery().data?.agent;
  const name = serverLabel(server);
  return (
    <Group label="Advanced">
      <Item title="Right now" subtitle={`What ${name} and its helpers are doing, on Home`} href={routeHash({ kind: 'run', project })} />
      <SetupRow href={routeHash({ kind: 'claude', project })} />
      <Item
        title="Terminal"
        subtitle={`A shell on the server, as ${name}`}
        onPress={() => {
          openTerminal(project);
        }}
      />
      {agent === undefined ? null : <Item title="Backup" subtitle="Export or import a .metro file" href={routeHash({ kind: 'backup', project })} />}
    </Group>
  );
}
