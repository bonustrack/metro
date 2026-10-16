import { type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { renameServer, setServerSlug, type Server } from '@metro-labs/client/api/servers';
import { SLUG_RE } from '@metro-labs/client/auth/org-segment';
import { location } from '@metro-labs/client/platform';
import { routeHash } from '@metro-labs/client/route';
import { AgentAvatar } from '../AgentAvatar.js';
import { useAvatarPicker } from '../AvatarPicker.js';
import { Modal } from '../Modal.js';
import { SaveField, useSave } from '../SaveField.js';
import { refreshServers } from '../../lib/queries.js';

const PICTURE = 72;
const NAME_MAX = 40;

function Field({ title, note, children }: { title: string; note: string; children: ReactNode }): ReactNode {
  return (
    <Col gap={8}>
      <Col gap={2}>
        <Text size="md">{title}</Text>
        <Text size="xs" role="secondary">
          {note}
        </Text>
      </Col>
      {children}
    </Col>
  );
}

function Picture({ server }: { server: Server }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const avatar = useAvatarPicker(server);
  return (
    <Field title="Picture" note="Shown in your agent list. PNG, JPEG, WebP or GIF.">
      <Row align="center" gap={12} wrap>
        <AgentAvatar seed={server.host} src={server.avatar} size={PICTURE} />
        <Button size="md" color="secondary" dark={dark} label={avatar.busy ? 'Saving…' : 'Change'} loading={avatar.busy} disabled={avatar.busy} onPress={avatar.pick} />
        {server.avatar === null ? null : <Button size="md" color="secondary" dark={dark} label="Remove" disabled={avatar.busy} onPress={avatar.remove} />}
      </Row>
      {avatar.error === null ? null : (
        <Text size="xs" role="danger">
          {avatar.error}
        </Text>
      )}
    </Field>
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
    <Field title="Name" note="What your team calls this agent.">
      <SaveField saving={saving} name="agent-name" label="Name" placeholder={server.host} />
    </Field>
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
      location().replace(routeHash({ kind: 'agent-settings', project: server.id }));
    },
    failure: 'Could not change the web address.',
  });
  return (
    <Field title="Web address" note="Used in this agent’s links. Lowercase letters, digits and dashes.">
      <SaveField saving={saving} name="agent-slug" label="Web address" placeholder={server.slug ?? ''} />
    </Field>
  );
}

export function ProfileModal({ server, open, onClose }: { server: Server; open: boolean; onClose: () => void }): ReactNode {
  return (
    <Modal title="Name and picture" open={open} onClose={onClose}>
      <Col gap={24}>
        <Picture server={server} />
        <Name key={server.name ?? ''} server={server} />
        <WebAddress key={server.slug ?? ''} server={server} />
      </Col>
    </Modal>
  );
}
