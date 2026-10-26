import { type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { agentSeed, renameServer, type Server, serverLabel, setServerSlug } from '@metro-labs/client/api/servers';
import { SLUG_RE } from '@metro-labs/client/auth/org-segment';
import { currentServer } from '@metro-labs/client/auth/daemon';
import { location } from '@metro-labs/client/platform';
import { routeHash } from '@metro-labs/client/route';
import { AgentAvatar } from '../AgentAvatar.js';
import { useAvatarPicker } from '../AvatarPicker.js';
import { AgentDeepPage } from '../agent/AgentDeepPage.js';
import { SaveField, useSave } from '../SaveField.js';
import { Group } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { Readable } from '../ui/Layout.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { AVATAR_SIZE } from '../ui/sizes.js';
import { refreshServers, useServersQuery } from '../../lib/queries.js';
import { useDocumentTitle } from '../../lib/title.js';

const NAME_MAX = 40;

function FieldSection({ label, note, children }: { label: string; note: string; children: ReactNode }): ReactNode {
  return (
    <Column gap={8}>
      <Text size="xs" color="secondary">
        {label}
      </Text>
      {children}
      <Text size="xs" color="secondary">
        {note}
      </Text>
    </Column>
  );
}

function Picture({ server }: { server: Server }): ReactNode {
  const avatar = useAvatarPicker(server);
  const buttons = (
    <Row align="center" gap={8}>
      {server.avatar === null ? null : <Button size="md" color="secondary" label="Remove" disabled={avatar.busy} onPress={avatar.remove} />}
      <Button size="md" color="secondary" label={avatar.busy ? 'Saving…' : 'Change'} loading={avatar.busy} disabled={avatar.busy} onPress={avatar.pick} />
    </Row>
  );
  return (
    <Group label="Picture" note="Shown in your agent list. PNG, JPEG, WebP or GIF." error={avatar.error}>
      <Item title={serverLabel(server)} leading={<AgentAvatar seed={agentSeed(server)} src={server.avatar} size={AVATAR_SIZE.header} />} trailing={buttons} />
    </Group>
  );
}

function Name({ server }: { server: Server }): ReactNode {
  const client = useQueryClient();
  const saving = useSave({
    initial: server.name ?? '',
    valid: (name) => name !== '' && name.length <= NAME_MAX,
    run: (name) => renameServer(server.id, name).then(() => refreshServers(client)),
    failure: 'Could not save the name.',
  });
  return (
    <FieldSection label="Name" note="What your team calls this agent.">
      <SaveField saving={saving} name="agent-name" label="Name" placeholder={server.host ?? undefined} />
    </FieldSection>
  );
}

function WebAddress({ server }: { server: Server }): ReactNode {
  const client = useQueryClient();
  const saving = useSave({
    initial: server.slug ?? '',
    clean: (slug) => slug.trim().toLowerCase(),
    valid: (slug) => SLUG_RE.test(slug),
    run: async (slug) => {
      await setServerSlug(server.id, slug);
      await refreshServers(client);
      location().replace(routeHash({ kind: 'agent-profile', project: server.id }));
    },
    failure: 'Could not change the web address.',
  });
  return (
    <FieldSection label="Web address" note="Used in this agent’s links. Lowercase letters, digits and dashes.">
      <SaveField saving={saving} name="agent-slug" label="Web address" placeholder={server.slug ?? ''} />
    </FieldSection>
  );
}

export function ProfilePage({ project, remote = false }: { project: string; remote?: boolean }): ReactNode {
  const servers = useServersQuery();
  const here = currentServer();
  const server = servers.data?.find((s) => s.id === here?.id);
  useDocumentTitle('Profile');
  return (
    <AgentDeepPage project={project} tab={remote ? 'home' : 'settings'} trail={[{ label: 'Profile' }]} title="Profile" subtitle="Name, picture and web address.">
      {server === undefined ? (
        <RowsSkeleton rows={3} />
      ) : (
        <Readable gap={40}>
          <Picture server={server} />
          <Name key={server.name ?? ''} server={server} />
          <WebAddress key={server.slug ?? ''} server={server} />
        </Readable>
      )}
    </AgentDeepPage>
  );
}
