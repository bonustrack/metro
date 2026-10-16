import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col } from '@stage-labs/kit/react-native/box';
import { Switch } from '@stage-labs/kit/react-native/switch';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { assignOrgConnector, unassignOrgConnector, type OrgConnector } from '@metro-labs/client/api/org-connectors';
import { serverLabel, type Server } from '@metro-labs/client/api/servers';
import { FormField } from '../FormField.js';
import { TextLink } from '../TextLink.js';
import { ErrorState } from '../ui/ErrorState.js';
import { Group } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { StateBlock } from '../ui/StateBlock.js';
import { Actions } from '../ui/Actions.js';
import { FocusFrame, FocusIntro, type FocusStep } from '../ui/FocusFrame.js';
import { SignInStep, type Added } from './AddSignIn.js';
import { AgentFace } from './AgentFace.js';
import { addressProblem } from '../../lib/connector-address.js';
import { go } from '../../lib/nav.js';
import { refreshOrgConnectors, useOrgConnectorsQuery } from '../../lib/org-connector-queries.js';
import { queryError, useServersQuery } from '../../lib/queries.js';

type AddStep = 'address' | 'sign-in' | 'agents';

const STEPS: readonly FocusStep[] = [
  { id: 'address', label: 'Address' },
  { id: 'sign-in', label: 'Sign in' },
  { id: 'agents', label: 'Agents' },
];

const TITLE = 'Add a connector';
const POLL_MS = 3000;
const close = (): void => { go({ kind: 'org-connectors' }); };

function AddressStep({ url, setUrl, onNext }: { url: string; setUrl: (url: string) => void; onNext: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [problem, setProblem] = useState<string | null>(null);
  const next = (): void => {
    const found = addressProblem(url);
    setProblem(found);
    if (found === null) onNext();
  };
  return (
    <>
      <FocusIntro title="Connect an app" text="Paste its connector address. Notion, Granola and n8n show it in their settings." />
      <Col gap={8}>
        <FormField label="Address" name="connector-url" value={url} placeholder="https://mcp.example.com/mcp" inputType="url" autoFocus dark={dark} onChangeText={(value) => { setUrl(value); setProblem(null); }} onSubmit={next} />
        {problem === null ? null : <Text size="xs" role="danger">{problem}</Text>}
      </Col>
      <Actions cancel={{ onPress: close }} main={{ label: 'Continue', disabled: url.trim() === '', onPress: next }} />
    </>
  );
}

function useToggle(connectorId: string): { busy: string | null; error: string | null; toggle: (server: Server, on: boolean) => void } {
  const client = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toggle = (server: Server, on: boolean): void => {
    setBusy(server.id);
    setError(null);
    (on ? assignOrgConnector(connectorId, server.id) : unassignOrgConnector(connectorId, server.id))
      .then(() => refreshOrgConnectors(client))
      .catch((err: unknown) => { setError(queryError(err, `Could not change ${serverLabel(server)}.`)); })
      .finally(() => { setBusy(null); });
  };
  return { busy, error, toggle };
}

function SignInState({ added, connector }: { added: Added; connector: OrgConnector | undefined }): ReactNode {
  if (!added.signingIn) return null;
  const done = connector?.signIn === 'connected';
  return (
    <Col gap={6}>
      <Text size="md" role={done ? 'success' : 'secondary'}>{done ? `Signed in to ${added.name}.` : 'Finish the sign-in in the new tab. This page notices when it is done.'}</Text>
      {added.link === null || done ? null : <TextLink url={added.link}>Open the sign-in</TextLink>}
    </Col>
  );
}

function AgentRows({ connector, servers }: { connector: OrgConnector | undefined; servers: Server[] }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const toggle = useToggle(connector?.id ?? '');
  const held = new Set(connector?.agents.map((agent) => agent.id) ?? []);
  if (servers.length === 0) return <Text size="md" role="secondary">No agent yet. You can add it to agents later.</Text>;
  return (
    <Group label="Agents" error={toggle.error}>
      {[...servers].sort((a, b) => serverLabel(a).localeCompare(serverLabel(b))).map((server) => (
        <Item key={server.id} title={serverLabel(server)} leading={<AgentFace server={server} dot={null} />} chevron={false}
          trailing={<Switch checked={held.has(server.id)} dark={dark} disabled={connector === undefined || toggle.busy !== null} name={serverLabel(server)} onChange={(on) => { toggle.toggle(server, on); }} />} />
      ))}
    </Group>
  );
}

function AgentList({ connector }: { connector: OrgConnector | undefined }): ReactNode {
  const servers = useServersQuery();
  if (servers.data === undefined && servers.error !== null) return <ErrorState title="Could not load the agents" text={queryError(servers.error, 'Metro did not answer.')} onRetry={servers.refetch} />;
  if (servers.data === undefined) return <RowsSkeleton rows={3} />;
  return <AgentRows connector={connector} servers={servers.data} />;
}

function AgentsStep({ added }: { added: Added }): ReactNode {
  const list = useOrgConnectorsQuery(added.signingIn ? POLL_MS : undefined);
  const connector = list.data?.connectors.find((row) => row.id === added.id);
  return (
    <>
      <FocusIntro title={`Who gets ${added.name}?`} text="Each agent you switch on gets its tools with the rules of the organization. You can change this later." />
      <SignInState added={added} connector={connector} />
      <AgentList connector={connector} />
      <Actions main={{ label: 'Done', onPress: () => { go({ kind: 'org-connector', id: added.id }); } }} />
    </>
  );
}

function Steps(): ReactNode {
  const [step, setStep] = useState<AddStep>('address');
  const [url, setUrl] = useState('');
  const [added, setAdded] = useState<Added | null>(null);
  const back = added === null ? (target: string) => { setStep(target === 'sign-in' ? 'sign-in' : 'address'); } : undefined;
  return (
    <FocusFrame title={TITLE} onClose={close} steps={STEPS} step={step} onStep={back}>
      {step === 'address' ? <AddressStep url={url} setUrl={setUrl} onNext={() => { setStep('sign-in'); }} /> : null}
      {step === 'sign-in' ? <SignInStep url={url.trim()} onBack={() => { setStep('address'); }} onCancel={close} onAdded={(result) => { setAdded(result); setStep('agents'); }} /> : null}
      {step === 'agents' && added !== null ? <AgentsStep added={added} /> : null}
    </FocusFrame>
  );
}

export function AddConnectorPage(): ReactNode {
  const { data } = useOrgConnectorsQuery();
  if (data !== undefined && !data.admin)
    return (
      <FocusFrame title={TITLE} onClose={close}>
        <StateBlock icon="plug" title="Only an admin can add a connector" text="Ask an admin of the organization to add it." action={{ label: 'Back to Connectors', onPress: close }} />
      </FocusFrame>
    );
  return <Steps />;
}
