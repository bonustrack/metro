import { type ReactNode, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Column } from '@stage-labs/kit/react-native/column';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { answerAppGrant, fetchAppGrant, type AppGrant } from '@metro-labs/client/api/oauth-grants';
import { serverLabel, type Server } from '@metro-labs/client/api/servers';
import { activeAccount } from '@metro-labs/client/auth/account';
import { AgentAvatar } from './AgentAvatar.js';
import { Icon } from './Icon.js';
import { Actions } from './ui/Actions.js';
import { ErrorState } from './ui/ErrorState.js';
import { FocusFrame, FocusIntro } from './ui/FocusFrame.js';
import { Group } from './ui/Group.js';
import { Item } from './ui/Item.js';
import { RowsSkeleton } from './ui/RowsSkeleton.js';
import { StateBlock } from './ui/StateBlock.js';
import { AVATAR_SIZE, ICON_SIZE } from './ui/sizes.js';
import { go } from '../lib/nav.js';
import { goExternal } from '../lib/open.js';
import { queryError, useServersQuery } from '../lib/queries.js';

const TITLE = 'Connect an app';
const NOTE = 'The app gets the connectors of this agent, under the same rules and approvals. It shows as an access key on the agent\'s page, where you can revoke it.';

const close = (): void => {
  go({ kind: 'servers' });
};

function AgentChoice({ server, chosen, onChoose }: { server: Server; chosen: boolean; onChoose: () => void }): ReactNode {
  const palette = useKitPalette();
  return (
    <Item
      title={serverLabel(server)}
      subtitle={server.kind === 'remote' ? 'No server' : undefined}
      leading={<AgentAvatar seed={server.id} src={server.avatar} size={AVATAR_SIZE.row} />}
      trailing={chosen ? <Icon name="check" size={ICON_SIZE.md} color={palette.link} /> : undefined}
      chevron={false}
      onPress={onChoose}
      label={`Use ${serverLabel(server)}`}
    />
  );
}

function ConsentForm({ grant, servers }: { grant: AppGrant; servers: Server[] }): ReactNode {
  const [agent, setAgent] = useState<string | null>(servers.length === 1 ? (servers[0]?.id ?? null) : null);
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const organization = activeAccount()?.organizationName ?? 'your organization';
  const answer = (decision: 'allow' | 'deny'): void => {
    if (decision === 'allow' && agent === null) return;
    setBusy(decision);
    setError(null);
    answerAppGrant(grant.id, decision === 'allow' && agent !== null ? { decision, agent } : { decision: 'deny' })
      .then(goExternal)
      .catch((err: unknown) => {
        setError(queryError(err, 'Metro did not answer. Try again.'));
        setBusy(null);
      });
  };
  return (
    <FocusFrame title={TITLE} onClose={close}>
      <Column gap={24}>
        <FocusIntro title={`${grant.client} wants to use an agent of ${organization}`} text={`Choose the agent. You will be sent back to ${grant.returnTo}.`} />
        <Group label="Agent" note={NOTE}>
          {servers.map((server) => (
            <AgentChoice key={server.id} server={server} chosen={agent === server.id} onChoose={() => { setAgent(server.id); }} />
          ))}
        </Group>
        <Actions
          error={error}
          cancel={{ label: busy === 'deny' ? 'Declining…' : 'Decline', onPress: () => { answer('deny'); }, disabled: busy !== null }}
          main={{ label: busy === 'allow' ? 'Connecting…' : 'Connect', busy: busy === 'allow', disabled: agent === null || busy !== null, onPress: () => { answer('allow'); } }}
        />
      </Column>
    </FocusFrame>
  );
}

function Refusal({ title, text }: { title: string; text: string }): ReactNode {
  return (
    <FocusFrame title={TITLE} onClose={close}>
      <StateBlock icon="plug" title={title} text={text} action={{ label: 'Back to Metro', onPress: close }} />
    </FocusFrame>
  );
}

export function AppConnectPage({ grant }: { grant: string }): ReactNode {
  const request = useQuery({ queryKey: ['app-grant', grant], queryFn: () => fetchAppGrant(grant), retry: false, staleTime: Infinity });
  const servers = useServersQuery();
  if (request.error !== null) return <Refusal title="This sign-in is no longer open" text={queryError(request.error, 'Start again from the app.')} />;
  if (activeAccount()?.role !== 'admin') return <Refusal title="Only an admin can connect an app" text="Ask an admin of your organization to sign in from the app, or to make an access key on the agent's page." />;
  if (servers.error !== null) {
    return (
      <FocusFrame title={TITLE} onClose={close}>
        <ErrorState title="Could not read the agents" text={queryError(servers.error, 'Metro did not answer.')} onRetry={servers.refetch} />
      </FocusFrame>
    );
  }
  const list = servers.data;
  if (request.data === undefined || list === undefined) {
    return (
      <FocusFrame title={TITLE} onClose={close}>
        <RowsSkeleton rows={3} />
      </FocusFrame>
    );
  }
  if (list.length === 0) return <Refusal title="No agent yet" text="Add an agent first, then connect the app again." />;
  return <ConsentForm grant={request.data} servers={list} />;
}
