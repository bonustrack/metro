import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { PageTitle } from './PageTitle.js';
import { ListHeader } from './ListHeader.js';
import { Loading } from './Loading.js';
import { RouteCard } from './RouteCard.js';
import { ProviderCard } from './ProviderCard.js';
import { ProviderModal, type Editing } from './ProviderModal.js';
import { ConnectProviderModal } from './ConnectProviderModal.js';
import { ModelPickerModal } from './ModelPickerModal.js';
import type { MenuItem } from './Dropdown.js';
import { chooseConnection, dropConnection, saveConnection, type ConnectionRow, type ModelSettings } from '../api/model.js';
import { usesKey } from '../api/providers.js';
import { queryError, refresh, useModelQuery } from '../api/queries.js';
import { useDocumentTitle } from '../title.js';

const HOW = 'Where the requests of a metro claude session go. Changing the model restarts the Claude session.';
const NONE_YET = 'Nothing is connected yet, so a request carries the Claude Code login of the session that sent it.';

type Run = (job: () => Promise<unknown>, fallback: string) => void;

function menuFor(c: ConnectionRow, edit: (e: Editing) => void, run: Run): MenuItem[] {
  const open = { label: usesKey(c.provider) ? 'Key and settings' : 'Sign in again', onSelect: () => { edit({ provider: c.provider, connection: c }); } };
  const zdr: MenuItem[] =
    c.provider === 'openrouter'
      ? [{ label: c.zdr ? 'Zero data retention: turn off' : 'Zero data retention: turn on', onSelect: () => { run(() => saveConnection(c.id, { zdr: !c.zdr }), 'Could not change the setting.'); } }]
      : [];
  return [open, ...zdr, { label: 'Disconnect', danger: true, onSelect: () => { run(() => dropConnection(c.id), 'Could not disconnect.'); } }];
}

function Body({ settings }: { settings: ModelSettings }): ReactNode {
  const client = useQueryClient();
  const dark = useKitScheme() === 'dark';
  const [picking, setPicking] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run: Run = (job, fallback) => {
    setError(null);
    job()
      .then(() => refresh(client, 'model'))
      .catch((err: unknown) => {
        setError(queryError(err, fallback));
      });
  };
  return (
    <Col gap={28}>
      <RouteCard settings={settings} onChange={() => { setPicking(true); }} />
      <Col gap={16}>
        <ListHeader title="Connections" count={settings.connections.length} action={<Button size="sm" dark={dark} label="Connect" onPress={() => { setConnecting(true); }} />} />
        {error === null ? null : <Text size="sm" role="danger">{error}</Text>}
        {settings.connections.length === 0 ? (
          <Text size="sm" role="secondary">{NONE_YET}</Text>
        ) : (
          <Row gap={12} wrap>
            {settings.connections.map((c) => (
              <ProviderCard
                key={c.id}
                connection={c}
                settings={settings}
                items={menuFor(c, setEditing, run)}
                onUse={() => {
                  run(() => chooseConnection(c.id), 'Could not switch the connection.');
                }}
              />
            ))}
          </Row>
        )}
      </Col>
      <ModelPickerModal open={picking} settings={settings} onClose={() => { setPicking(false); }} />
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
    <Col gap={20}>
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
