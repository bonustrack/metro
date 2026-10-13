import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { dashboardModel, dashboardReadingStale, dashboardSession, type DashboardRow } from '@metro-labs/client/api/dashboard';
import { releaseAvailability, type MetroRelease } from '@metro-labs/client/api/metro-release';
import { namedSegment } from '@metro-labs/client/auth/org-segment';
import { AgentAvatar } from './AgentAvatar.js';
import { RouteLink } from './RouteLink.js';
import { Spinner } from './Spinner.js';
import { Tip } from './Tip.js';
import { UsageBar } from './ModelUsage.js';
import { side } from './ui/edges.js';
import { SHRINK } from '../lib/style.js';

const AVATAR = 32;
const DOT = 8;
const FULL = 0.95;
export const AGENT_COLUMNS = { agent: 2.4, status: 1.6, model: 2.6, metro: 1.6 } as const;
export const MENU_WIDTH = 40;

const styles = StyleSheet.create({
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2 },
  menu: { width: MENU_WIDTH, alignItems: 'flex-end' },
});

const stamp = (at: number): string => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function Checking(): ReactNode {
  const palette = useKitPalette();
  return <Spinner color={palette.link} />;
}

function Pair({ top, bottom, link }: { top: string | null; bottom: string | null; link?: string }): ReactNode {
  return (
    <Col gap={2} minWidth={0}>
      {top === null ? <Checking /> : <Text size="sm" numberOfLines={1} style={SHRINK}>{top}</Text>}
      {bottom === null ? null : link === undefined ? (
        <Text size="2xs" role="secondary" numberOfLines={1}>{bottom}</Text>
      ) : (
        <RouteLink to={link} label={bottom}><Text size="2xs" role="link" numberOfLines={1}>{bottom}</Text></RouteLink>
      )}
    </Col>
  );
}

function useDotColor(status: string): string {
  const palette = useKitPalette();
  if (status === 'Error' || status === 'Unreachable') return palette.danger;
  if (status === 'Waiting for approval') return palette.primary;
  if (status === 'Working' || status === 'Running' || status === 'Idle' || status === 'Starting' || status === 'Compacting') return palette.success;
  return palette.sub;
}

function StatusCell({ row, now }: { row: DashboardRow; now: number }): ReactNode {
  const session = dashboardSession(row.session, now);
  const color = useDotColor(session.status);
  return (
    <Col gap={2} minWidth={0}>
      <Row gap={8} align="center">
        {session.status === 'Checking…' ? <Checking /> : <>
          <View style={[styles.dot, { backgroundColor: color }]} />
          <Text size="sm" numberOfLines={1} style={SHRINK}>{session.status}</Text>
        </>}
      </Row>
      {session.harness === 'Unknown' ? null : <Text size="2xs" role="secondary" numberOfLines={1}>{session.harness}</Text>}
    </Col>
  );
}

function ModelCell({ row, now }: { row: DashboardRow; now: number }): ReactNode {
  const { data, error, unavailable, at } = row.model;
  if (data === null) return <Pair top={unavailable || error !== null ? 'Unavailable' : null} bottom={null} />;
  const model = dashboardModel(data, now);
  const stale = dashboardReadingStale(row.model, now);
  if (stale || model.used === null) return <Pair top={model.model} bottom={stale && at !== null ? `Last seen ${stamp(at)}` : model.usage} />;
  return (
    <Col gap={4} minWidth={0}>
      <Text size="sm" numberOfLines={1} style={SHRINK}>{model.model}</Text>
      <Tip label={model.usage}><UsageBar used={model.used} blocked={model.used >= FULL} /></Tip>
    </Col>
  );
}

function metroLine(row: DashboardRow, release: MetroRelease | undefined, releaseFailed: boolean, now: number): string | null {
  if (row.session.unavailable || row.model.unavailable) return 'Update for status';
  const availability = releaseAvailability(row.mode.data?.version ?? null, release, releaseFailed, now);
  return availability.kind === 'newer' ? 'Update available' : null;
}

interface Props {
  row: DashboardRow;
  now: number;
  narrow: boolean;
  release: MetroRelease | undefined;
  releaseFailed: boolean;
  note?: string;
  menu?: ReactNode;
}

function MetroCell({ row, now, release, releaseFailed, note, href }: Omit<Props, 'narrow' | 'menu'> & { href: string }): ReactNode {
  const version = row.mode.data?.version ?? (row.mode.error === null ? null : 'Unknown');
  if (note !== undefined) return <Pair top={version} bottom={note} />;
  const line = metroLine(row, release, releaseFailed, now);
  return <Pair top={version} bottom={line} link={line === null ? undefined : `${href}/server`} />;
}

function Identity({ row, href, detail }: { row: DashboardRow; href: string; detail: string }): ReactNode {
  const { organization, agent } = row;
  const name = agent.name ?? agent.slug ?? agent.id;
  return (
    <RouteLink to={href} label={`Open ${name} in ${organization.name ?? organization.id}`}>
      <Row gap={12} align="center">
        <AgentAvatar seed={agent.host} src={agent.avatar} size={AVATAR} />
        <Col gap={2} flex={1} minWidth={0}>
          <Text size="sm" weight="semibold" numberOfLines={1} style={SHRINK}>{name}</Text>
          <Text size="2xs" role="secondary" numberOfLines={1}>{detail}</Text>
        </Col>
      </Row>
    </RouteLink>
  );
}

export function AllAgentRow({ row, now, narrow, release, releaseFailed, note, menu }: Props): ReactNode {
  const palette = useKitPalette();
  const { organization, agent } = row;
  const orgName = organization.name ?? organization.slug ?? organization.id;
  const href = `#/${namedSegment(organization.id, organization.slug)}/${namedSegment(agent.id, agent.slug)}`;
  const border = { bottom: side(palette.border) };
  const trailing = <View style={styles.menu}>{menu}</View>;
  if (narrow) {
    const session = dashboardSession(row.session, now);
    const model = row.model.data === null ? null : dashboardModel(row.model.data, now).model;
    const detail = [session.status === 'Checking…' ? null : session.status, model, note ?? row.mode.data?.version].filter((part) => part != null).join(' · ');
    return (
      <Row gap={12} align="center" padding={{ y: 12 }} border={border}>
        <Col flex={1} minWidth={0}><Identity row={row} href={href} detail={detail} /></Col>
        {trailing}
      </Row>
    );
  }
  return (
    <Row gap={24} align="center" padding={{ y: 12 }} border={border}>
      <Col flex={AGENT_COLUMNS.agent} minWidth={0}><Identity row={row} href={href} detail={orgName} /></Col>
      <Col flex={AGENT_COLUMNS.status} minWidth={0}><StatusCell row={row} now={now} /></Col>
      <Col flex={AGENT_COLUMNS.model} minWidth={0}><ModelCell row={row} now={now} /></Col>
      <Col flex={AGENT_COLUMNS.metro} minWidth={0}><MetroCell row={row} now={now} release={release} releaseFailed={releaseFailed} note={note} href={href} /></Col>
      {trailing}
    </Row>
  );
}
