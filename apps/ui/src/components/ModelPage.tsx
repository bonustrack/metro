import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { PageTitle } from './PageTitle.js';
import { Loading } from './Loading.js';
import { ProviderRow } from './ProviderCard.js';
import { CurrentModel } from './CurrentModel.js';
import { SettingsGroup } from './SettingsSection.js';
import { ProviderModal, type Editing } from './ProviderModal.js';
import { ConnectProviderModal } from './ConnectProviderModal.js';
import { ModelPickerModal } from './ModelPickerModal.js';
import type { MenuItem } from './Dropdown.js';
import { chooseConnection, dropConnection, saveConnection, type ConnectionRow, type ModelSettings } from '../api/model.js';
import { usesKey } from '../api/providers.js';
import { queryError, refresh, useModelQuery } from '../api/queries.js';
import { useDocumentTitle } from '../title.js';

const HOW = 'The AI your agent thinks with. Switching restarts the agent, which takes a few seconds.';
const NONE_YET = 'No provider yet. Your agent uses the Claude login of its server until you add one.';

type Run = (job: () => Promise<unknown>, fallback: string) => void;

function menuFor(c: ConnectionRow, edit: (e: Editing) => void, run: Run, pickFor: (c: ConnectionRow) => void): MenuItem[] {
  const model = { label: 'Change model', onSelect: () => { pickFor(c); } };
  const open = { label: usesKey(c.provider) ? 'Key and settings' : 'Sign in again', onSelect: () => { edit({ provider: c.provider, connection: c }); } };
  const zdr: MenuItem[] =
    c.provider === 'openrouter'
      ? [{ label: c.zdr ? 'Zero data retention: turn off' : 'Zero data retention: turn on', onSelect: () => { run(() => saveConnection(c.id, { zdr: !c.zdr }), 'Could not change the setting.'); } }]
      : [];
  return [model, open, ...zdr, { label: 'Disconnect', danger: true, onSelect: () => { run(() => dropConnection(c.id), 'Could not disconnect.'); } }];
}

function Body({ settings }: { settings: ModelSettings }): ReactNode {
  const client = useQueryClient();
  const dark = useKitScheme() === 'dark';
  const [picking, setPicking] = useState(false);
  const [scope, setScope] = useState<ConnectionRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run: Run = (job, fallback) => {
    setError(null);
    setBusy(true);
    job()
      .then(() => refresh(client, 'model'))
      .catch((err: unknown) => {
        setError(queryError(err, fallback));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <Col gap={32}>
      <CurrentModel settings={settings} onChange={() => { setPicking(true); }} />
      <SettingsGroup title="Providers" action={<Button size="sm" dark={dark} label="Add provider" onPress={() => { setConnecting(true); }} />}>
        {settings.connections.length === 0 ? (
          <div className="settings-row">
            <Text size="sm" role="secondary">{NONE_YET}</Text>
          </div>
        ) : (
          settings.connections.map((c) => (
            <ProviderRow
              key={c.id}
              connection={c}
              settings={settings}
              items={menuFor(c, setEditing, run, setScope)}
              busy={busy}
              onUse={() => {
                run(() => chooseConnection(c.id), 'Could not switch provider.');
              }}
            />
          ))
        )}
      </SettingsGroup>
      {error === null ? null : <Text size="sm" role="danger">{error}</Text>}
      <ModelPickerModal open={picking} settings={settings} onClose={() => { setPicking(false); }} />
      <ModelPickerModal open={scope !== null} settings={settings} scope={scope ?? undefined} onClose={() => { setScope(null); }} />
      <ConnectProviderModal
        open={connecting}
        onPick={(provider) => {
          setConnecting(false);
          setEditing({ provider, connection: null });
        }}
        onClose={() => { setConnecting(false); }}
      />
      <ProviderModal editing={editing} onClose={() => { setEditing(null); }} />
    </Col>
  );
}

export function ModelPage(): ReactNode {
  const model = useModelQuery();
  useDocumentTitle('Model');
  return (
    <Col gap={32}>
      <Col gap={8}>
        <PageTitle>Model</PageTitle>
        <Text size="sm" role="secondary">
          {HOW}
        </Text>
      </Col>
      {model.error !== null ? (
        <Text size="sm" role="danger">
          {queryError(model.error, 'Could not read the model settings.')}
        </Text>
      ) : model.data === undefined ? (
        <Loading />
      ) : (
        <Body settings={model.data} />
      )}
    </Col>
  );
}
