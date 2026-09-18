import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button, Input } from './ui.js';
import { PageTitle } from './PageTitle.js';
import { Loading } from './Loading.js';
import { AgentAvatar } from './AgentAvatar.js';
import { useAvatarPicker } from './AvatarPicker.js';
import { ConfirmModal } from './ConfirmModal.js';
import { ExportAgent } from './ExportAgent.js';
import { ImportAgent } from './ImportAgent.js';
import { ResetAgentKey } from './ResetAgentKey.js';
import { resetAgentKey, type AgentSummary } from '../api/client.js';
import { queryError, refreshAgents, refreshServers, useServersQuery, useStationsQuery } from '../api/queries.js';
import { removeServer, renameServer, serverLabel, type Server } from '../api/servers.js';
import { currentServer } from '../auth/daemon.js';
import { useDocumentTitle } from '../title.js';

const PAGE_AVATAR = 56;
const NAME_MAX = 40;

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }): ReactNode {
  const palette = useKitPalette();
  return (
    <Col gap={12} padding={{ bottom: 20 }} border={{ bottom: { width: 1, color: palette.border } }}>
      <Col gap={2}>
        <Text weight="semibold">{title}</Text>
        {note === undefined ? null : (
          <Text size="sm" role="secondary">
            {note}
          </Text>
        )}
      </Col>
      {children}
    </Col>
  );
}

function AvatarSection({ server }: { server: Server }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const avatar = useAvatarPicker(server);
  return (
    <Section title="Avatar" note="A PNG, JPEG, WebP or GIF; it is resized to 128 pixels in the browser.">
      <Row align="center" gap={16} wrap>
        <AgentAvatar seed={server.host} src={server.avatar} size={PAGE_AVATAR} />
        <Button size="sm" color="secondary" dark={dark} label={avatar.busy ? 'Saving…' : 'Set avatar'} loading={avatar.busy} disabled={avatar.busy} onPress={avatar.pick} />
        {server.avatar === null ? null : <Button size="sm" color="secondary" dark={dark} label="Remove avatar" disabled={avatar.busy} onPress={avatar.remove} />}
        {avatar.error === null ? null : (
          <Text size="sm" role="danger">
            {avatar.error}
          </Text>
        )}
      </Row>
      {avatar.input}
    </Section>
  );
}

function NameSection({ server }: { server: Server }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const client = useQueryClient();
  const [name, setName] = useState(server.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  const ready = trimmed !== '' && trimmed.length <= NAME_MAX && trimmed !== (server.name ?? '');
  const save = (): void => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    renameServer(server.id, trimmed)
      .then(() => refreshServers(client))
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not save the name.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <Section title="Name" note="What the agent is called in your list and in the rail.">
      <Row gap={8} align="center" wrap>
        <Input name="agent-name" value={name} placeholder={server.host} dark={dark} disabled={busy} onChangeText={setName} />
        <Button color="primary" dark={dark} label={busy ? 'Saving…' : 'Save'} loading={busy} disabled={busy || !ready} onPress={save} />
      </Row>
      {error === null ? null : (
        <Text size="sm" role="danger">
          {error}
        </Text>
      )}
    </Section>
  );
}

function TransferSection({ agent, name }: { agent: AgentSummary; name: string }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const portable = { id: agent.id, name, key: agent.key ?? '' };
  return (
    <Section title="Export and import" note="A .metro file sealed with a passphrase: channels, connectors, skills, memory, sessions and the model setup.">
      <Row gap={8} wrap>
        <Button
          color="secondary"
          dark={dark}
          label="Export"
          onPress={() => {
            setExporting(true);
          }}
        />
        <Button
          color="secondary"
          dark={dark}
          label="Import"
          onPress={() => {
            setImporting(true);
          }}
        />
      </Row>
      <ExportAgent
        open={exporting}
        agent={portable}
        onClose={() => {
          setExporting(false);
        }}
      />
      <ImportAgent
        open={importing}
        agent={portable}
        onClose={() => {
          setImporting(false);
        }}
      />
    </Section>
  );
}

function KeySection({ agent }: { agent: AgentSummary }): ReactNode {
  const client = useQueryClient();
  return (
    <Section title="API key" note="The key Claude Code on this machine presents to the daemon. A reset restarts the Claude session with the new key.">
      <Row>
        <ResetAgentKey
          agent={agent}
          onReset={async (id) => {
            await resetAgentKey(id);
            refreshAgents(client);
          }}
        />
      </Row>
    </Section>
  );
}

function RemoveSection({ server }: { server: Server }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = (): void => {
    setBusy(true);
    setError(null);
    removeServer(server.id)
      .then(() => refreshServers(client))
      .then(() => {
        window.location.hash = '#/';
      })
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not remove the agent.'));
        setBusy(false);
      });
  };
  return (
    <Section title="Remove" note="Takes the agent out of your list. The machine keeps running and can be added again by its address.">
      <Row>
        <Button
          color="danger"
          dark={dark}
          label="Remove agent"
          onPress={() => {
            setOpen(true);
          }}
        />
      </Row>
      <ConfirmModal
        open={open}
        title="Remove this agent?"
        lines={[`${serverLabel(server)} leaves your list and the rail. Nothing on the machine is deleted.`]}
        prompt="Type delete to confirm."
        confirmWord="delete"
        confirmLabel="Remove agent"
        busy={busy}
        error={error}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        onConfirm={remove}
      />
    </Section>
  );
}

export function AgentSettings(): ReactNode {
  const servers = useServersQuery();
  const stations = useStationsQuery();
  const here = currentServer();
  const server = servers.data?.find((s) => s.id === here?.id);
  const agent = stations.data?.agents[0];
  useDocumentTitle('Settings');
  if (server === undefined || agent === undefined) return <Loading />;
  const name = serverLabel(server);
  return (
    <Col gap={20}>
      <PageTitle>Settings</PageTitle>
      <AvatarSection server={server} />
      <NameSection key={server.name ?? ''} server={server} />
      <TransferSection agent={agent} name={name} />
      <KeySection agent={agent} />
      <RemoveSection server={server} />
    </Col>
  );
}
