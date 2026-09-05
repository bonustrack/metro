import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { useQueryClient } from '@tanstack/react-query';
import { Text, Button } from './ui';
import { SHRINK } from '../theme';
import { PageTitle } from './PageTitle';
import { Loading } from './Loading';
import { MetroVersion } from './MetroVersion';
import { DaemonControls } from './DaemonControls';
import { NameModal } from './NameModal';
import { queryError, refreshServers, useMachineQuery, useServersQuery } from '../api/queries';
import { removeServer, renameServer, serverLabel, type Server } from '../api/servers';
import { systemLabel, uptimeLabel, type Machine } from '../api/machine';
import { whenLabel } from '../api/when';
import { useDocumentTitle } from '../title';

const FALLBACK = 'Could not read this server.';

function InfoRow({ label, value, href }: { label: string; value: string; href?: string }): ReactNode {
  const palette = useKitPalette();
  return (
    <Row justify="between" align="center" gap={16} padding={{ y: 10 }} border={{ bottom: { width: 1, color: palette.border } }}>
      <Text size="sm" role="secondary">
        {label}
      </Text>
      <Text size="sm" numberOfLines={1} style={SHRINK}>
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
        <InfoRow label="Owner" value={machine.owner ?? 'not set'} />
      </Section>
      <Section title="Machine">
        <InfoRow label="Hostname" value={machine.hostname} />
        <InfoRow label="System" value={systemLabel(machine)} />
        <InfoRow label="Bun" value={machine.bun ?? 'unknown'} />
        <InfoRow label="Up for" value={`${uptimeLabel(machine.uptimeSeconds)}${started}`} />
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
  const dark = useKitScheme() === 'dark';
  const client = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  return (
    <Section title="On metro.box">
      <InfoRow label="Id" value={server.id} />
      <InfoRow label="Address" value={server.host} />
      <InfoRow label="Added" value={server.addedAt === '' ? 'unknown' : whenLabel(server.addedAt)} />
      <Row gap={8} padding={{ top: 12 }}>
        <Button
          color="secondary"
          dark={dark}
          label={server.name === null ? 'Name' : 'Rename'}
          onPress={() => {
            setRenaming(true);
          }}
        />
        <Button
          color="secondary"
          dark={dark}
          label="Remove from my servers"
          onPress={() => {
            removeServer(server.id)
              .then(() => refreshServers(client))
              .then(() => {
                window.location.hash = '#/';
              })
              .catch(() => undefined);
          }}
        />
      </Row>
      <NameModal
        title="Name this server"
        action="Save"
        placeholder={server.host}
        initial={server.name ?? ''}
        failure="Could not save the name."
        open={renaming}
        onClose={() => {
          setRenaming(false);
        }}
        onSubmit={async (name) => {
          const saved = await renameServer(server.id, name);
          await refreshServers(client);
          return saved;
        }}
      />
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
