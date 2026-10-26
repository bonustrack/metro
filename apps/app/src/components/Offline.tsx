import { type ReactNode } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { boxesOf, serverLabel, type BoxServer } from '@metro-labs/client/api/servers';
import { currentServer } from '@metro-labs/client/auth/daemon';
import { type Selection } from '@metro-labs/client/selection';
import { DeleteServerSection } from './DeleteServer.js';
import { Icon } from './Icon.js';
import { ServerResources } from './ServerResources.js';
import { ServerSizeSection } from './ServerSize.js';
import { ServerStorageSection } from './ServerStorage.js';
import { StateBlock } from './ui/StateBlock.js';
import { shortVersion } from '../lib/agent-line.js';
import { useLatestUsageQuery, useServerStatus, useServersQuery } from '../lib/queries.js';
import { useTechnicalDetails } from '../lib/technical.js';
import { useBootingState } from '../lib/use-launch.js';
import { go } from '../lib/nav.js';

const OFFLINE_PAGES: Selection['kind'][] = ['agent-settings', 'settings', 'launch-log'];

export const worksOffline = (kind: Selection['kind']): boolean => OFFLINE_PAGES.includes(kind);

const CHECK = 18;

interface Check {
  label: string;
  ok: boolean;
}

function Checks({ checks }: { checks: Check[] }): ReactNode {
  const palette = useKitPalette();
  return (
    <Column gap={4} margin={{ top: 4 }}>
      {checks.map((check) => (
        <Row key={check.label} gap={8} align="center">
          <Icon name={check.ok ? 'check' : 'ban'} size={CHECK} color={check.ok ? palette.success : palette.danger} />
          <Text size="xs" color={palette.text}>
            {check.label}
          </Text>
        </Row>
      ))}
    </Column>
  );
}

function useChecks(server: BoxServer | undefined): Check[] {
  const servers = useServersQuery();
  const usage = useLatestUsageQuery().data?.[server?.id ?? ''];
  const runs = usage === undefined || usage.cpu === null ? [] : [{ label: 'The server runs', ok: true }];
  const reach = servers.isSuccess ? [{ label: 'Your connection works', ok: true }] : [];
  return [...runs, { label: 'Metro does not answer', ok: false }, ...reach];
}

function GettingReady({ server, state }: { server: BoxServer; state: string }): ReactNode {
  const step = state === 'running' ? 'Installing Metro' : 'Starting the server';
  return (
    <StateBlock spinner title={`${serverLabel(server)} is getting ready`} text={`${step}. You can close this page.`}
      action={{ label: 'See progress', onPress: () => { go({ kind: 'launch-log', project: server.id }); } }} />
  );
}

function ServerSections({ server }: { server: BoxServer }): ReactNode {
  return (
    <Column gap={24}>
      <ServerResources serverId={server.id} />
      <ServerSizeSection serverId={server.id} launchedOnly />
      <ServerStorageSection serverId={server.id} launchedOnly />
      <DeleteServerSection server={server} />
    </Column>
  );
}

function OfflineState({ server, name, onRetry }: { server: BoxServer | undefined; name: string; onRetry: () => void }): ReactNode {
  const technical = useTechnicalDetails();
  const checks = useChecks(server);
  const host = currentServer()?.host;
  return (
    <Column gap={40}>
      <StateBlock icon="server" danger title={`${name} is offline`} text={technical && host !== undefined ? `Metro does not answer at ${host}.` : 'Metro does not answer.'}
        action={{ label: 'Try again', primary: true, onPress: onRetry }}>
        <Checks checks={checks} />
      </StateBlock>
      {server === undefined ? null : <ServerSections server={server} />}
    </Column>
  );
}

function KnownServer({ server, onRetry }: { server: BoxServer; onRetry: () => void }): ReactNode {
  const status = useServerStatus(server.host).data;
  const booting = useBootingState(server, status !== undefined && status.state !== 'live');
  const name = serverLabel(server);
  if (booting !== null) return <GettingReady server={server} state={booting} />;
  if (status?.state === 'updating') {
    const target = status.updatingTo === undefined ? '' : `To ${shortVersion(status.updatingTo)}. `;
    return <StateBlock spinner title={`${name} is updating`} text={`${target}Back in about a minute.`} />;
  }
  return <OfflineState server={server} name={name} onRetry={onRetry} />;
}

export function OfflinePanel({ onRetry }: { onRetry: () => void }): ReactNode {
  const servers = useServersQuery();
  const here = currentServer();
  const server = boxesOf(servers.data ?? []).find((s) => s.id === here?.id);
  if (server !== undefined) return <KnownServer server={server} onRetry={onRetry} />;
  return <OfflineState server={undefined} name="This agent" onRetry={onRetry} />;
}
