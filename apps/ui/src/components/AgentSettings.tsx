import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { SettingsSection } from './SettingsSection.js';
import { PageTitle } from './PageTitle.js';
import { Loading } from './Loading.js';
import { AgentAvatar } from './AgentAvatar.js';
import { useAvatarPicker } from './AvatarPicker.js';
import { ConfirmDialog, useConfirm } from './DeleteMenu.js';
import { SaveField, useSave } from './SaveField.js';
import { ExportAgent } from './ExportAgent.js';
import { ImportAgent } from './ImportAgent.js';
import { type AgentSummary } from '../api/client.js';
import { refreshServers, useServersQuery, useStationsQuery } from '../api/queries.js';
import { removeServer, renameServer, serverLabel, setServerSlug, type Server } from '../api/servers.js';
import { routeHash } from '../route.js';
import { currentServer } from '../auth/daemon.js';
import { SLUG_RE } from '../auth/org-segment.js';
import { MoveSection } from './MoveAgent.js';
import { useDocumentTitle } from '../title.js';

const PAGE_AVATAR = 56;
const NAME_MAX = 40;

function AvatarSection({ server }: { server: Server }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const avatar = useAvatarPicker(server);
  return (
    <SettingsSection title="Avatar" note="A PNG, JPEG, WebP or GIF; it is resized to 128 pixels in the browser.">
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
    </SettingsSection>
  );
}

function NameSection({ server }: { server: Server }): ReactNode {
  const client = useQueryClient();
  const saving = useSave({
    initial: server.name ?? '',
    valid: (name) => name !== '' && name.length <= NAME_MAX,
    run: (name) => renameServer(server.id, name).then(() => refreshServers(client)),
    failure: 'Could not save the name.',
  });
  return (
    <SettingsSection title="Name" note="What the agent is called in your list and in the rail.">
      <SaveField saving={saving} name="agent-name" placeholder={server.host} />
    </SettingsSection>
  );
}

function SlugSection({ server }: { server: Server }): ReactNode {
  const client = useQueryClient();
  const saving = useSave({
    initial: server.slug ?? '',
    clean: (slug) => slug.trim().toLowerCase(),
    valid: (slug) => SLUG_RE.test(slug),
    run: async (slug) => {
      await setServerSlug(server.id, slug);
      await refreshServers(client);
      window.location.replace(`${window.location.pathname}${routeHash({ kind: 'agent-settings', project: server.id })}`);
    },
    failure: 'Could not change the slug.',
  });
  return (
    <SettingsSection title="Slug" note="The agent's part of every address. Lowercase letters, digits and dashes, unique within the organization.">
      <SaveField saving={saving} name="agent-slug" placeholder={server.slug ?? ''} />
    </SettingsSection>
  );
}

function TransferSection({ agent, name }: { agent: AgentSummary; name: string }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const portable = { id: agent.id, name };
  return (
    <SettingsSection title="Export and import" note="A .metro file sealed with a passphrase: channels, connectors, skills, memory, sessions and the model setup.">
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
    </SettingsSection>
  );
}

function RemoveSection({ server }: { server: Server }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const client = useQueryClient();
  const confirming = useConfirm(
    async () => {
      await removeServer(server.id);
      await refreshServers(client);
    },
    'Could not remove the agent.',
    () => {
      window.location.hash = routeHash({ kind: 'servers' });
    },
  );
  return (
    <SettingsSection title="Remove" note="Takes the agent out of your list. The machine keeps running and can be added again by its address.">
      <Row>
        <Button color="danger" dark={dark} label="Remove agent" onPress={confirming.show} />
      </Row>
      <ConfirmDialog
        confirming={confirming}
        title="Remove this agent?"
        lines={[`${serverLabel(server)} leaves your list and the rail. Nothing on the machine is deleted.`]}
        action="Remove agent"
      />
    </SettingsSection>
  );
}

export function AgentSettings(): ReactNode {
  const servers = useServersQuery();
  const stations = useStationsQuery();
  const here = currentServer();
  const server = servers.data?.find((s) => s.id === here?.id);
  const agent = stations.data?.agent;
  useDocumentTitle('Settings');
  if (server === undefined) return <Loading />;
  const name = serverLabel(server);
  return (
    <Col gap={20}>
      <PageTitle>Settings</PageTitle>
      <AvatarSection server={server} />
      <NameSection key={server.name ?? ''} server={server} />
      <SlugSection key={server.slug ?? ''} server={server} />
      {agent === undefined ? null : <TransferSection agent={agent} name={name} />}
      <MoveSection server={server} />
      <RemoveSection server={server} />
    </Col>
  );
}
