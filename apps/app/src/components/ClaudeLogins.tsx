import { type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { activeAccount } from '@metro-labs/client/auth/account';
import { removeClaudeLogin, type ClaudeLoginRow, type ModelSettings } from '@metro-labs/client/api/model';
import { SettingsGroup, SettingsPad } from './SettingsSection.js';
import { ClaudeLoginCard } from './ClaudeLogin.js';
import { ConfirmDialog, useConfirm } from './DeleteMenu.js';
import { refresh } from '../lib/queries.js';

const NOTE = 'Claude subscriptions signed in on this server. Only this agent can use them, in its own model order.';

function RemoveLogin({ login, onDone }: { login: ClaudeLoginRow; onDone: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const removing = useConfirm(() => removeClaudeLogin(login.id), 'Could not remove the Claude login.', onDone);
  const who = login.email ?? 'This Claude login';
  return (
    <Row>
      <Button size="md" color="secondary" dark={dark} label="Remove" onPress={removing.show} />
      <ConfirmDialog confirming={removing} title="Remove this Claude login?" lines={[`${who} is signed out of this server. A model order that uses it skips it.`]} action="Remove login" />
    </Row>
  );
}

export function ClaudeLogins({ settings }: { settings: ModelSettings }): ReactNode {
  const client = useQueryClient();
  const admin = activeAccount()?.role === 'admin';
  const done = (): void => {
    refresh(client, 'model').catch(() => undefined);
  };
  return (
    <SettingsGroup title="Claude logins" note={NOTE}>
      {settings.claude.map((login) => (
        <SettingsPad key={login.id}>
          <ClaudeLoginCard login={login} onDone={done} />
          {admin ? <RemoveLogin login={login} onDone={done} /> : null}
        </SettingsPad>
      ))}
      <SettingsPad>
        <ClaudeLoginCard login={null} onDone={done} />
      </SettingsPad>
    </SettingsGroup>
  );
}
