import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { PageTitle } from './PageTitle.js';
import { Loading } from './Loading.js';
import { ConnectionItem } from './ProviderCard.js';
import { CardUsage } from './AgentModel.js';
import { ModelRouting, type RouteActions } from './ModelRouting.js';
import { RouteEditor } from './RouteEditor.js';
import { SettingsGroup, SettingsPad } from './SettingsSection.js';
import { ProviderModal, type Editing } from './ProviderModal.js';
import type { MenuItem } from './Dropdown.js';
import { dropConnection, saveFallbacks, type ConnectionRow, type ModelSettings } from '@metro-labs/client/api/model';
import { usesKey } from '@metro-labs/client/api/providers';
import { movedFallbacks, promoteFallback, type Slot } from '@metro-labs/client/api/route-edit';
import { modelNote } from '@metro-labs/client/api/runner';
import { queryError, refresh, useClaudeSetupQuery, useModelQuery } from '../lib/queries.js';
import { useDocumentTitle } from '../lib/title.js';

const NONE_YET = 'No connection yet. Your agent uses the Claude login of its server until you add one.';
const CONNECTIONS = 'The accounts and keys the list above can use. Each one shows its own usage.';

type Run = (job: () => Promise<unknown>, fallback: string) => void;

function menuFor(c: ConnectionRow, edit: (e: Editing) => void, run: Run): MenuItem[] {
  const signIn = !usesKey(c.provider) || (c.provider === 'anthropic' && !c.hasKey);
  return [
    { label: signIn ? 'Sign in again' : 'Key and settings', onSelect: () => { edit({ provider: c.provider, connection: c }); } },
    { label: 'Disconnect', danger: true, separated: true, onSelect: () => { run(() => dropConnection(c.id), 'Could not disconnect.'); } },
  ];
}

function useRun(): { busy: boolean; error: string | null; run: Run } {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
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
  return { busy, error, run };
}

function Body({ settings }: { settings: ModelSettings }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [slot, setSlot] = useState<Slot | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const { busy, error, run } = useRun();
  const list = settings.fallbacks ?? [];
  const actions: RouteActions = {
    edit: setSlot,
    move: (at, by) => { run(() => saveFallbacks(movedFallbacks(list, at, by)), 'Could not move the model.'); },
    promote: (at) => { run(() => promoteFallback(settings, at), 'Could not make it the primary model.'); },
    remove: (at) => { run(() => saveFallbacks(list.filter((_, other) => other !== at)), 'Could not remove the model.'); },
  };
  const add = <Button size="md" dark={dark} label="Add connection" onPress={() => { setEditing({ provider: null, connection: null }); }} />;
  return (
    <Col gap={32}>
      <ModelRouting settings={settings} busy={busy} actions={actions} />
      {error === null ? null : <Text size="2xs" role="danger">{error}</Text>}
      <SettingsGroup title="Connections" note={CONNECTIONS} action={add}>
        {settings.connections.length === 0 ? (
          <SettingsPad row>
            <Text size="2xs" role="secondary">{NONE_YET}</Text>
            <CardUsage usage={settings.usage.passthrough} />
          </SettingsPad>
        ) : (
          settings.connections.map((c) => <ConnectionItem key={c.id} connection={c} settings={settings} items={menuFor(c, setEditing, run)} onOpen={() => { setEditing({ provider: c.provider, connection: c }); }} />)
        )}
      </SettingsGroup>
      <RouteEditor settings={settings} slot={slot} onClose={() => { setSlot(null); }} />
      <ProviderModal editing={editing} onClose={() => { setEditing(null); }} />
    </Col>
  );
}

export function ModelPage(): ReactNode {
  const model = useModelQuery();
  const setup = useClaudeSetupQuery();
  useDocumentTitle('Model');
  return (
    <Col gap={32}>
      <Col gap={8}>
        <PageTitle>Model</PageTitle>
        <Text size="2xs" role="secondary">
          {modelNote(setup.data)}
        </Text>
      </Col>
      {model.error !== null ? (
        <Text size="2xs" role="danger">
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
