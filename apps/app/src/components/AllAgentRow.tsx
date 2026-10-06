import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { dashboardModel, dashboardSession, type DashboardRow } from '@metro-labs/client/api/dashboard';
import { namedSegment } from '@metro-labs/client/auth/org-segment';
import { RouteLink } from './RouteLink.js';

function modelObserved(reading: DashboardRow['model'], now: number): string | null {
  if (reading.data === null) return null;
  const { at, error } = reading;
  if (error === null && at !== null && at <= now && now - at <= 60_000) return null;
  return at === null ? 'Observation time unavailable.' : `Last seen ${new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
}

function ModelObservation({ reading, now }: { reading: DashboardRow['model']; now: number }): ReactNode {
  const observed = modelObserved(reading, now);
  return (
    <>
      {observed === null ? null : <Text size="2xs" role="secondary">{observed}</Text>}
      {reading.error === null ? null : <Text size="2xs" role="secondary">{reading.error}</Text>}
      {reading.unavailable ? <Text size="2xs" role="secondary">Update Metro to see model usage.</Text> : null}
    </>
  );
}

function ModelReading({ row, now }: { row: DashboardRow; now: number }): ReactNode {
  const { data, error, unavailable } = row.model;
  if (data === null)
    return (
      <Col gap={4}>
        <Text size="sm">{unavailable || error !== null ? 'Model usage unavailable' : 'Checking…'}</Text>
        <ModelObservation reading={row.model} now={now} />
      </Col>
    );
  const model = dashboardModel(data, now);
  return (
    <Col gap={4}>
      <Text size="sm">{model.model}</Text>
      <Text size="2xs" role="secondary">{model.connection}</Text>
      <Text size="sm">{model.usage}</Text>
      {model.report === null ? null : <Text size="2xs" role="secondary">{model.report}</Text>}
      {model.note === null ? null : <Text size="2xs" role="secondary">{model.note}</Text>}
      <ModelObservation reading={row.model} now={now} />
    </Col>
  );
}

export function AllAgentRow({ row, now, narrow }: { row: DashboardRow; now: number; narrow: boolean }): ReactNode {
  const { organization, agent } = row;
  const orgName = organization.name ?? organization.slug ?? organization.id;
  const agentName = agent.name ?? agent.slug ?? agent.id;
  const href = `#/${namedSegment(organization.id, organization.slug)}/${namedSegment(agent.id, agent.slug)}`;
  const session = dashboardSession(row.session, now);
  const identity = (
    <Col gap={4}>
      <Text size="2xs" role="secondary">{orgName}</Text>
      <RouteLink to={href} label={`Open ${agentName} in ${orgName}`}>
        <Text size="md" weight="semibold" role="link">{agentName}</Text>
      </RouteLink>
    </Col>
  );
  const status = (
    <Col gap={4}>
      {narrow ? <Text size="2xs" role="secondary">Status</Text> : null}
      <Text size="sm">{session.status}</Text>
      {session.observed === null ? null : <Text size="2xs" role="secondary">{session.observed}</Text>}
    </Col>
  );
  const model = (
    <Col gap={4}>
      {narrow ? <Text size="2xs" role="secondary">Model usage</Text> : null}
      <ModelReading row={row} now={now} />
    </Col>
  );
  const harness = (
    <Col gap={4}>
      {narrow ? <Text size="2xs" role="secondary">Harness</Text> : null}
      <Text size="sm">{session.harness}</Text>
    </Col>
  );
  if (narrow)
    return (
      <Col gap={16} padding={{ y: 16 }}>
        {identity}
        <Row gap={24} align="start">
          <Col flex={1} minWidth={0}>{status}</Col>
          <Col flex={1} minWidth={0}>{harness}</Col>
        </Row>
        {model}
      </Col>
    );
  return (
    <Row gap={24} align="start" padding={{ y: 16 }}>
      <Col flex={2} minWidth={0}>{identity}</Col>
      <Col flex={2} minWidth={0}>{status}</Col>
      <Col flex={3} minWidth={0}>{model}</Col>
      <Col flex={1} minWidth={0}>{harness}</Col>
    </Row>
  );
}
