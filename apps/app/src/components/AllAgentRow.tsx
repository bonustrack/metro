import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Badge } from '@stage-labs/kit/react-native/badge';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { dashboardModel, dashboardReadingStale, dashboardSession, type DashboardRow } from '@metro-labs/client/api/dashboard';
import { releaseAvailability, type MetroRelease } from '@metro-labs/client/api/metro-release';
import { namedSegment } from '@metro-labs/client/auth/org-segment';
import { AgentAvatar } from './AgentAvatar.js';
import { Icon, type IconName } from './Icon.js';
import { RouteLink } from './RouteLink.js';
import { side } from './ui/edges.js';

const stamp = (at: number): string => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function MissingModel({ row }: { row: DashboardRow }): ReactNode {
  const { error, unavailable } = row.model;
  return <Col gap={4}>
    <Text size="sm" role="secondary">{unavailable || error !== null ? 'Model usage unavailable' : 'Checking…'}</Text>
    {!unavailable && error !== null ? <Text size="2xs" role="secondary">{error}</Text> : null}
  </Col>;
}

function ModelReading({ row, now }: { row: DashboardRow; now: number }): ReactNode {
  const { data, error, at } = row.model;
  if (data === null) return <MissingModel row={row} />;
  const model = dashboardModel(data, now);
  return <Col gap={3}>
    <Text size="sm" weight="medium">{model.model}</Text>
    <Text size="2xs" role="secondary">{model.connection}</Text>
    <Text size="sm">{model.usage}</Text>
    {model.report === null ? null : <Text size="2xs" role="secondary">{model.report}</Text>}
    {model.note === null || model.note === 'Primary route' ? null : <Text size="2xs" role="secondary">{model.note}</Text>}
    {dashboardReadingStale(row.model, now) ? <Text size="2xs" role="secondary">{at === null ? 'Observation time unavailable.' : `Last seen ${stamp(at)}`}{error === null ? '' : `. ${error}`}</Text> : null}
  </Col>;
}

function statusIcon(status: string): IconName {
  if (status === 'Working' || status === 'Running') return 'play';
  if (status === 'Idle') return 'check';
  if (status.includes('Stopped') || status === 'Metro stopped') return 'pause';
  if (status === 'Waiting for approval') return 'hand';
  if (status === 'Error' || status === 'Unreachable') return 'exclamationCircle';
  return 'clock';
}

function StatusReading({ row, now }: { row: DashboardRow; now: number }): ReactNode {
  const palette = useKitPalette();
  const session = dashboardSession(row.session, now);
  const color = session.status === 'Error' ? 'danger' : session.status === 'Waiting for approval' ? 'warning' : undefined;
  return <Col gap={6}>
    <Row gap={6} align="center" wrap>
      <Icon name={statusIcon(session.status)} size={14} color={palette.sub} />
      <Badge label={session.status} color={color} />
    </Row>
    <Text size="2xs" role="secondary">{session.harness}</Text>
    {session.observed === null || row.session.unavailable ? null : <Text size="2xs" role="secondary">{session.observed}</Text>}
  </Col>;
}

interface Props {
  row: DashboardRow;
  now: number;
  narrow: boolean;
  release: MetroRelease | undefined;
  releaseFailed: boolean;
}

function RowUpdate({ availability, stale, href, name }: { availability: ReturnType<typeof releaseAvailability>; stale: boolean; href: string; name: string }): ReactNode {
  if (availability.kind === 'newer') return <RouteLink to={`${href}/server`} label={`Update Metro for ${name}`}>
    <Text size="2xs" role="link">{stale ? 'Update available at last report' : 'Update available'}</Text>
  </RouteLink>;
  return !stale && availability.kind === 'current' ? <Text size="2xs" role="secondary">Up to date</Text> : null;
}

const versionLabel = (row: DashboardRow): string => row.mode.data?.version ?? (row.mode.error === null && row.mode.data === null ? 'Checking…' : 'Version unavailable');

function VersionReading({ row, now, release, releaseFailed, href }: Omit<Props, 'narrow'> & { href: string }): ReactNode {
  const stale = row.mode.data !== null && dashboardReadingStale(row.mode, now);
  const availability = releaseAvailability(row.mode.data?.version ?? null, release, releaseFailed, now);
  return <Col gap={5}>
    <Text size="2xs">{versionLabel(row)}</Text>
    {stale ? <Text size="2xs" role="secondary">{row.mode.at === null ? 'Version stale' : `Last seen ${stamp(row.mode.at)}`}</Text> : null}
    <RowUpdate availability={availability} stale={stale} href={href} name={row.agent.name ?? row.agent.id} />
    {row.session.unavailable || row.model.unavailable ? <Text size="2xs" role="secondary">Update Metro for status and usage.</Text> : null}
  </Col>;
}

export function AllAgentRow({ row, now, narrow, release, releaseFailed }: Props): ReactNode {
  const palette = useKitPalette();
  const { organization, agent } = row;
  const orgName = organization.name ?? organization.slug ?? organization.id;
  const agentName = agent.name ?? agent.slug ?? agent.id;
  const href = `#/${namedSegment(organization.id, organization.slug)}/${namedSegment(agent.id, agent.slug)}`;
  const identity = <RouteLink to={href} label={`Open ${agentName} in ${orgName}`}>
    <Row gap={12} align="center">
      <AgentAvatar seed={agent.host} src={agent.avatar} size={40} />
      <Col gap={3} flex={1} minWidth={0}>
        <Text size="md" weight="semibold" role="link">{agentName}</Text>
        <Text size="2xs" role="secondary">{orgName}</Text>
      </Col>
    </Row>
  </RouteLink>;
  const status = <StatusReading row={row} now={now} />;
  const model = <ModelReading row={row} now={now} />;
  const version = <VersionReading row={row} now={now} release={release} releaseFailed={releaseFailed} href={href} />;
  const border = { bottom: side(palette.border) };
  if (narrow) return <Col gap={16} padding={{ y: 20 }} border={border}>
    {identity}
    <Row gap={16} align="start">
      <Col flex={1} minWidth={0}>{status}</Col>
      <Col flex={1} minWidth={0}><Text size="2xs" role="secondary">Metro</Text>{version}</Col>
    </Row>
    {model}
  </Col>;
  return <Row gap={24} align="start" padding={{ y: 20 }} border={border}>
    <Col flex={2.4} minWidth={0}>{identity}</Col>
    <Col flex={1.8} minWidth={0}>{status}</Col>
    <Col flex={3} minWidth={0}>{model}</Col>
    <Col flex={1.6} minWidth={0}>{version}</Col>
  </Row>;
}
