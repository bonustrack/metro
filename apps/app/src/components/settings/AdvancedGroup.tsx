import { type ReactNode, useState } from 'react';
import { serverLabel, type Server } from '@metro-labs/client/api/servers';
import { routeHash } from '@metro-labs/client/route';
import { ExportAgent } from '../ExportAgent.js';
import { ImportAgent } from '../ImportAgent.js';
import { Group } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { PickDialog } from './PickDialog.js';
import { useClaudeSetupQuery, useStationsQuery } from '../../lib/queries.js';
import { modeName, promptKind } from '../../lib/settings-values.js';
import { useTechnicalDetails } from '../../lib/technical.js';
import { openTerminal } from '../../lib/open-terminal.js';

export type Transfer = 'pick' | 'export' | 'import' | null;

function SetupRow({ href }: { href: string }): ReactNode {
  const technical = useTechnicalDetails();
  const setup = useClaudeSetupQuery().data;
  const detail = technical && setup !== undefined ? `${modeName(setup.permissionMode)} · ${promptKind(setup.systemPrompt)}` : 'Permissions and system prompt';
  return <Item title="Agent SDK setup" subtitle={detail} href={href} />;
}

export function TransferDialogs({ server, step, onStep }: { server: Server; step: Transfer; onStep: (next: Transfer) => void }): ReactNode {
  const agent = useStationsQuery().data?.agent;
  if (agent === undefined) return null;
  const portable = { id: agent.id, name: serverLabel(server) };
  const close = (): void => {
    onStep(null);
  };
  return (
    <>
      <PickDialog
        open={step === 'pick'}
        title="Export or import"
        note="A .metro file holds channels, skills, memory and sessions, locked with a passphrase."
        options={[
          { title: 'Export a backup', subtitle: 'Download everything in one file', onPick: () => { onStep('export'); } },
          { title: 'Import a backup', subtitle: 'Add what a file holds. Nothing else is deleted.', onPick: () => { onStep('import'); } },
        ]}
        onClose={close}
      />
      <ExportAgent open={step === 'export'} agent={portable} onClose={close} />
      <ImportAgent open={step === 'import'} agent={portable} onClose={close} />
    </>
  );
}

export function AdvancedGroup({ server, project }: { server: Server; project: string }): ReactNode {
  const [step, setStep] = useState<Transfer>(null);
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
      {agent === undefined ? null : (
        <Item
          title="Backup"
          subtitle="Export or import a .metro file"
          onPress={() => {
            setStep('pick');
          }}
        />
      )}
      <TransferDialogs server={server} step={step} onStep={setStep} />
    </Group>
  );
}
