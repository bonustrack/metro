import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button, Input } from './ui.js';
import { Modal } from './Modal.js';
import { ProviderLogo } from './ProviderLogo.js';
import { priceLabel, PROVIDERS, releaseLabel, saveConnection, chooseConnection, type ConnectionRow, type ModelOption, type ModelSettings } from '../api/model.js';
import { pickRows, typedRow, type PickRow } from '../api/providers.js';
import { queryError, refreshModel, useConnectionModelsQuery, useOpenRouterZdrQuery } from '../api/queries.js';
import { GROW } from '../theme.js';

const IN_SESSION = 'Inside a running session, /model <provider>:<id> switches that session only.';
const LOGO = 16;

function useLists(connections: ConnectionRow[], open: boolean): { models: Record<string, ModelOption[]>; loading: boolean; errors: string[] } {
  const shown = open ? connections.slice(0, 6) : [];
  const queries = [0, 1, 2, 3, 4, 5].map((at) => useConnectionModelsQuery(shown[at]));
  const models: Record<string, ModelOption[]> = {};
  const errors: string[] = [];
  queries.forEach((q, at) => {
    const conn = shown[at];
    if (conn === undefined) return;
    if (q.data !== undefined) models[conn.id] = q.data;
    if (q.error !== null) errors.push(queryError(q.error, `Could not list the models of ${conn.label}.`));
  });
  return { models, loading: queries.some((q) => q.isFetching), errors };
}

const rowDetail = (row: PickRow): string =>
  [row.label, row.name === row.id || row.id === '' ? '' : row.name, releaseLabel(row), priceLabel(row)].filter((x) => x !== '').join(' · ');

function RowButton({ row, onPick }: { row: PickRow; onPick: (row: PickRow) => void }): ReactNode {
  return (
    <button type="button" className={row.current ? 'model-match model-match-current' : 'model-match'} aria-current={row.current ? 'true' : undefined} onClick={() => { onPick(row); }}>
      <span className="model-match-id">{row.id === '' ? row.name : row.id}</span>
      <span className="model-match-name">{rowDetail(row)}</span>
    </button>
  );
}

function Chips({ connections, chip, onChip }: { connections: ConnectionRow[]; chip: string; onChip: (c: string) => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Row gap={6} wrap>
      <Button size="sm" dark={dark} color={chip === 'all' ? 'primary' : 'secondary'} label="All" onPress={() => { onChip('all'); }} />
      {connections.map((c) => (
        <Button
          key={c.id}
          size="sm"
          dark={dark}
          color={c.id === chip ? 'primary' : 'secondary'}
          label={c.label}
          icon={<ProviderLogo provider={PROVIDERS.find((p) => p.id === c.provider)} size={LOGO} />}
          onPress={() => { onChip(c.id); }}
        />
      ))}
    </Row>
  );
}

function Rows({ rows, typed, chip, busy, onPick }: { rows: PickRow[]; typed: PickRow | null; chip: string; busy: boolean; onPick: (row: PickRow) => void }): ReactNode {
  if (rows.length === 0 && typed === null)
    return (
      <Text size="sm" role="secondary">{chip === 'all' ? 'No model matches. Pick a connection to use what you typed as it is.' : 'No model matches.'}</Text>
    );
  return (
    <div className={busy ? 'model-matches model-rows model-rows-busy' : 'model-matches model-rows'}>
      {typed === null ? null : <RowButton row={{ ...typed, name: `Use "${typed.id}" as typed` }} onPick={onPick} />}
      {rows.map((row) => (
        <RowButton key={`${row.connection}:${row.id}`} row={row} onPick={onPick} />
      ))}
    </div>
  );
}

export function ModelPickerModal({ open, settings, onClose }: { open: boolean; settings: ModelSettings; onClose: () => void }): ReactNode {
  const client = useQueryClient();
  const dark = useKitScheme() === 'dark';
  const [query, setQuery] = useState('');
  const [chip, setChip] = useState('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lists = useLists(settings.connections, open);
  const anyZdr = settings.connections.some((c) => c.provider === 'openrouter' && c.zdr);
  const zdr = useOpenRouterZdrQuery(open && anyZdr);
  const input = { models: lists.models, connections: settings.connections, chip, query, route: settings.route, zdr: anyZdr ? (zdr.data ?? null) : null };
  const rows = pickRows(input);
  const typed = typedRow(input);
  const pick = (row: PickRow): void => {
    setBusy(true);
    setError(null);
    saveConnection(row.connection, { model: row.id })
      .then(() => chooseConnection(row.connection))
      .then(() => refreshModel(client))
      .then(onClose)
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not change the model.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <Modal title="Change model" open={open} onClose={onClose}>
      <Col gap={12}>
        <Input name="model-search" value={query} placeholder="Search a model" dark={dark} onChangeText={setQuery} style={GROW} inputProps={{ autoFocus: true, autoCapitalize: 'none', autoComplete: 'off', autoCorrect: false, spellCheck: false }} />
        <Chips connections={settings.connections} chip={chip} onChip={setChip} />
        {lists.loading ? <Text size="sm" role="secondary">Asking for the models…</Text> : null}
        {lists.errors.map((e) => (
          <Text key={e} size="sm" role="danger">{e}</Text>
        ))}
        {error === null ? null : <Text size="sm" role="danger">{error}</Text>}
        <Rows rows={rows} typed={typed} chip={chip} busy={busy} onPick={pick} />
        <Text size="sm" role="secondary">{IN_SESSION}</Text>
      </Col>
    </Modal>
  );
}
