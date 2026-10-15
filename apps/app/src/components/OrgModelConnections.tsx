import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { deleteOrgModel, type OrgModelConnection, type OrgModels } from '@metro-labs/client/api/org-models';
import { ConnectionItem } from './ProviderCard.js';
import { DeleteMenu } from './DeleteMenu.js';
import { ProviderModal, type Editing } from './ProviderModal.js';
import { SettingsGroup, SettingsPad } from './SettingsSection.js';
import { afterModelChange } from '../lib/model-queries.js';
import { orgConnectionDetail } from './model-view.js';

const NOTE = 'The keys and accounts your agents use. Requests go from each agent straight to the provider.';
const EMPTY = 'No connection yet. Add OpenRouter, Codex, an Anthropic key or Amazon Bedrock.';

function menuLabel(connection: OrgModelConnection): string {
  if (connection.provider === 'codex') return 'Sign in again';
  return connection.signedOut ? 'Add a key' : 'Settings and key';
}

function Remove({ connection, onOpen }: { connection: OrgModelConnection; onOpen: () => void }): ReactNode {
  const client = useQueryClient();
  return (
    <DeleteMenu
      label={`${connection.label} menu`}
      items={[{ label: menuLabel(connection), onSelect: onOpen }]}
      item="Remove"
      title="Remove this connection?"
      lines={[`“${connection.label}” and its key or sign-in are removed. Every model order that uses it loses it.`]}
      action="Remove connection"
      failure="Could not remove the connection."
      run={async () => {
        await deleteOrgModel(connection.id);
        await afterModelChange(client);
      }}
    />
  );
}

export function OrgModelConnections({ list }: { list: OrgModels }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [editing, setEditing] = useState<Editing | null>(null);
  const add = list.admin ? <Button size="md" dark={dark} label="Add connection" onPress={() => { setEditing({ provider: null, connection: null }); }} /> : undefined;
  const open = (c: OrgModelConnection) => (): void => {
    setEditing({ provider: c.provider, connection: c });
  };
  return (
    <>
      <SettingsGroup title="Connections" note={NOTE} action={add}>
        {list.connections.length === 0 ? (
          <SettingsPad>
            <Text size="md" role="secondary">{EMPTY}</Text>
          </SettingsPad>
        ) : (
          list.connections.map((c) => (
            <ConnectionItem key={c.id} connection={c} detail={orgConnectionDetail(list, c)} onOpen={list.admin ? open(c) : undefined} trailing={list.admin ? <Remove connection={c} onOpen={open(c)} /> : undefined} />
          ))
        )}
      </SettingsGroup>
      <ProviderModal editing={editing} onClose={() => { setEditing(null); }} />
    </>
  );
}
