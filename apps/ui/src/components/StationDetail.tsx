import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui';
import { SHRINK } from '../theme';
import { PageTitle } from './PageTitle';
import { stationLabel } from '../api/attach';
import { stationFields, type AccountRow } from '../api/accounts';
import { type AgentSummary } from '../api/client';
import { BackLink } from './BackLink';
import { CopyBlock } from './CopyBlock';
import { DetachAccount } from './DetachAccount';
import { opensElsewhere } from './link';
import { routeHash } from '../route';
import { StationIcon } from './StationIcon';
import { type DetachHandler } from './AccountList';

function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <Col gap={10}>
      <Text size="lg" weight="semibold">{title}</Text>
      {children}
    </Col>
  );
}

function Detail({ label, value }: { label: string; value: string }): ReactNode {
  const palette = useKitPalette();
  return (
    <Row
      justify="between"
      align="center"
      gap={16}
      padding={{ y: 12 }}
      border={{ bottom: { width: 1, color: palette.border } }}
    >
      <Text size="sm" role="secondary">{label}</Text>
      <Text size="sm" numberOfLines={1} style={SHRINK}>{value}</Text>
    </Row>
  );
}

interface StationDetailProps {
  station: string;
  project: string;
  row: AccountRow;
  agent: AgentSummary | undefined;
  verbs: string[];
  onOpenAgent: (id: string) => void;
  onDetach?: DetachHandler;
}

function Heading({
  station,
  project,
  row,
  agent,
  onOpenAgent,
}: StationDetailProps): ReactNode {
  const palette = useKitPalette();
  const handle = stationFields(row).handle ?? row.id ?? stationLabel(station);
  return (
    <Col gap={8}>
      <Row gap={10} align="center">
        <StationIcon station={station} size={18} color={palette.sub} />
        <Text size="sm" role="secondary">{stationLabel(station)}</Text>
      </Row>
      <PageTitle>{handle}</PageTitle>
      <Row gap={6} align="center" wrap>
        <Text size="sm" role="secondary">{row.id ?? 'no id'}</Text>
        {agent === undefined ? null : (
          <>
            <Text size="sm" role="secondary">on</Text>
            <a
              className="hint-link"
              href={routeHash({ kind: 'home', project })}
              onClick={(e) => {
                if (opensElsewhere(e)) return;
                e.preventDefault();
                onOpenAgent(agent.id);
              }}
            >
              <Text size="sm">{agent.name}</Text>
            </a>
          </>
        )}
      </Row>
    </Col>
  );
}

export function StationDetail(props: StationDetailProps): ReactNode {
  const { project } = props;
  const { station, row, agent, verbs, onOpenAgent, onDetach } = props;
  const { url, endpoint, details } = stationFields(row);
  const id = row.id;

  return (
    <Col gap={20}>
      <Col gap={12}>
        <Row justify="between" align="center" gap={12}>
          {agent === undefined ? (
            <Col />
          ) : (
            <BackLink
              label={agent.name}
              href={routeHash({ kind: 'home', project })}
              onPress={() => {
                onOpenAgent(agent.id);
              }}
            />
          )}
          {onDetach !== undefined && id !== null ? (
            <DetachAccount station={station} accountId={id} onDetach={onDetach} />
          ) : null}
        </Row>
        <Heading {...props} />
      </Col>

      {id === null ? null : (
        <CopyBlock label="line" value={`metro://${station}/${id}`} />
      )}

      {endpoint === undefined ? null : (
        <Section title="Endpoint">
          <Col gap={8}>
            <CopyBlock label="post events here" value={endpoint} secret />
            <Text size="sm" role="secondary">
              The whole URL is the credential. Anyone holding it can post events
              to this agent, so paste it straight into the provider and do not
              put it anywhere public.
            </Text>
          </Col>
        </Section>
      )}

      {url === undefined ? null : (
        <Section title="Link">
          <Col>
            <CopyBlock
              label="profile"
              value={url}
              actions={
                <a className="hint-link" href={url} target="_blank" rel="noreferrer">
                  <Text size="sm">Open</Text>
                </a>
              }
            />
          </Col>
        </Section>
      )}

      {details.length === 0 ? null : (
        <Section title="Details">
          <Col>
            {details.map((field) => (
              <Detail key={field.label} label={field.label} value={field.value} />
            ))}
          </Col>
        </Section>
      )}

      <Section title="What this station can do">
        {verbs.length === 0 ? (
          <Text size="sm" role="secondary">
            Inbound only. Events from this station reach the agent, and the agent
            cannot send, reply or react on its lines.
          </Text>
        ) : (
          <Row gap={8} wrap>
            {verbs.map((verb) => (
              <Text key={verb} size="sm">{verb}</Text>
            ))}
          </Row>
        )}
      </Section>
    </Col>
  );
}
