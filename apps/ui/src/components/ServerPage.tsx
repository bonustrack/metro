import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui.js';
import { SHRINK } from '../theme.js';
import { PageTitle } from './PageTitle.js';
import { Loading } from './Loading.js';
import { MetroVersion } from './MetroVersion.js';
import { DaemonControls } from './DaemonControls.js';
import { ClaudeSession } from './ClaudeSession.js';
import { queryError, useMachineQuery, useServersQuery } from '../api/queries.js';
import { serverLabel, type Server } from '../api/servers.js';
import { diskLabel, systemLabel, uptimeLabel, type Machine } from '../api/machine.js';
import { whenLabel } from '../api/when.js';
import { ownerLabel } from '../auth/owner-label.js';
import { useDocumentTitle } from '../title.js';

const FALLBACK = 'Could not read this server.';

function InfoRow({ label, value, href, danger = false }: { label: string; value: string; href?: string; danger?: boolean }): ReactNode {
  const palette = useKitPalette();
  return (
    <Row justify="between" align="center" gap={16} padding={{ y: 10 }} border={{ bottom: { width: 1, color: palette.border } }}>
      <Text size="sm" role="secondary">
        {label}
      </Text>
      <Text size="sm" numberOfLines={1} style={SHRINK} role={danger ? 'danger' : undefined}>
        {href === undefined ? (
          value
        ) : (
          <a className="hint-link" href={href} target="_blank" rel="noreferrer">
            {value}
          </a>
        )}
      </Text>
    </Row>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <Col gap={4}>
      <Text size="md" weight="semibold">
        {title}
      </Text>
      <Col>{children}</Col>
    </Col>
  );
}

function MachineFacts({ machine }: { machine: Machine }): ReactNode {
  const started = machine.startedAt === null ? '' : ` (since ${whenLabel(machine.startedAt)})`;
  return (
    <>
      <Section title="Address">
        {machine.publicUrl === null ? (
          <InfoRow label="Public" value="none yet: the Funnel is not up" />
        ) : (
          <InfoRow label="Public" value={machine.publicUrl} href={machine.publicUrl} />
        )}
        <InfoRow label="On the machine" value={`http://127.0.0.1:${String(machine.port)}`} />
        <InfoRow label="Owner" value={ownerLabel(machine.owner)} />
      </Section>
      <Section title="Machine">
        <InfoRow label="Hostname" value={machine.hostname} />
        <InfoRow label="System" value={systemLabel(machine)} />
        <InfoRow label="Bun" value={machine.bun ?? 'unknown'} />
        <InfoRow label="Up for" value={`${uptimeLabel(machine.uptimeSeconds)}${started}`} />
        {machine.disk === null ? null : <InfoRow label="Disk" value={diskLabel(machine.disk).text} danger={diskLabel(machine.disk).full} />}
      </Section>
      <Section title="Paths">
        <InfoRow label="Agents" value={machine.agentsDir} />
        <InfoRow label="Runtime" value={machine.runtimeStore ?? 'run from source'} />
        <InfoRow label="Claude Code" value={machine.claudeDir} />
      </Section>
    </>
  );
}

function ListEntry({ server }: { server: Server }): ReactNode {
  return (
    <Section title="On metro.box">
      <InfoRow label="Id" value={server.id} />
      <InfoRow label="Address" value={server.host} />
      <InfoRow label="Added" value={server.addedAt === '' ? 'unknown' : whenLabel(server.addedAt)} />
    </Section>
  );
}

export function ServerPage({ project }: { project: string }): ReactNode {
  const machine = useMachineQuery();
  const servers = useServersQuery();
  const server = servers.data?.find((s) => s.id === project);
  useDocumentTitle(server === undefined ? 'Server' : serverLabel(server));
  return (
    <Col gap={20}>
      <Col gap={8}>
        <PageTitle>{server === undefined ? 'Server' : serverLabel(server)}</PageTitle>
        {server?.name ? (
          <Text size="sm" role="secondary">
            {server.host}
          </Text>
        ) : null}
        <MetroVersion />
        <DaemonControls />
      </Col>
      <ClaudeSession project={project} />
      {machine.error !== null ? (
        <Text size="sm" role="danger">
          {queryError(machine.error, FALLBACK)}
        </Text>
      ) : machine.data === undefined ? (
        <Loading />
      ) : (
        <MachineFacts machine={machine.data} />
      )}
      {server === undefined ? null : <ListEntry server={server} />}
    </Col>
  );
}
