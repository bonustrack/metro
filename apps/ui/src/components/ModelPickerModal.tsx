import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col } from '@stage-labs/kit/react-native/box';
import { Icon } from '@stage-labs/kit/react-native/icon';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Input } from './ui.js';
import { Modal } from './Modal.js';
import { ProviderLogo } from './ProviderLogo.js';
import { priceLabel, PROVIDERS, saveConnection, chooseConnection, type ConnectionRow, type ModelOption, type ModelSettings } from '../api/model.js';
import { pickRows, typedRow, type PickRow } from '../api/providers.js';
import { queryError, refresh, useConnectionModelsQuery, useOpenRouterZdrQuery } from '../api/queries.js';
import { GROW } from '../theme.js';

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

function niceName(row: PickRow): string {
  if (row.name === '' || row.name === row.id) return row.id;
  const cut = row.name.indexOf(': ');
  return cut === -1 ? row.name : row.name.slice(cut + 2);
}

const rowDetail = (row: PickRow): string => [niceName(row) === row.id ? '' : row.id, priceLabel(row)].filter((x) => x !== '').join(' · ');

function RowButton({ row, onPick }: { row: PickRow; onPick: (row: PickRow) => void }): ReactNode {
  const palette = useKitPalette();
  return (
    <button type="button" className={row.current ? 'pick-row is-current' : 'pick-row'} aria-current={row.current ? 'true' : undefined} onClick={() => { onPick(row); }}>
      <span className="pick-row-text">
        <span className="pick-row-name">{niceName(row)}</span>
        <span className="pick-row-detail">{rowDetail(row)}</span>
      </span>
      {row.current ? <Icon name="check" size={18} color={palette.link} /> : null}
    </button>
  );
}

function Groups({ rows, typed, connections, busy, onPick }: { rows: PickRow[]; typed: PickRow | null; connections: ConnectionRow[]; busy: boolean; onPick: (row: PickRow) => void }): ReactNode {
  if (rows.length === 0 && typed === null)
    return (
      <Text size="sm" role="secondary">
        No model matches your search.
      </Text>
    );
  return (
    <div className={busy ? 'pick-list is-busy' : 'pick-list'}>
      {typed === null ? null : <RowButton row={{ ...typed, name: `Use “${typed.id}”` }} onPick={onPick} />}
      {connections.map((c) => {
        const mine = rows.filter((row) => row.connection === c.id);
        if (mine.length === 0) return null;
        return (
          <div key={c.id} className="pick-group">
            <div className="pick-group-head">
              <ProviderLogo provider={PROVIDERS.find((p) => p.id === c.provider)} size={LOGO} />
              <span>{c.label}</span>
            </div>
            {mine.map((row) => (
              <RowButton key={`${row.connection}:${row.id}`} row={row} onPick={onPick} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function usePick(scope: ConnectionRow | undefined, onClose: () => void): { busy: boolean; error: string | null; pick: (row: PickRow) => void } {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = (row: PickRow): void => {
    setBusy(true);
    setError(null);
    saveConnection(row.connection, { model: row.id })
      .then(() => (scope === undefined ? chooseConnection(row.connection) : undefined))
      .then(() => refresh(client, 'model'))
      .then(onClose)
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not change the model.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return { busy, error, pick };
}

function chipOf(settings: ModelSettings, scope: ConnectionRow | undefined): string {
  if (scope !== undefined) return scope.id;
  return settings.route !== '' ? settings.route : (settings.connections[0]?.id ?? 'all');
}

const titleOf = (scope: ConnectionRow | undefined): string => (scope === undefined ? 'Choose a model' : `Model for ${scope.label}`);

const scopedRows = (rows: PickRow[], scope: ConnectionRow | undefined): PickRow[] =>
  scope === undefined ? rows : rows.map((row) => ({ ...row, current: row.id === scope.model }));

export function ModelPickerModal({ open, settings, scope, onClose }: { open: boolean; settings: ModelSettings; scope?: ConnectionRow; onClose: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [query, setQuery] = useState('');
  const chip = scope?.id ?? 'all';
  const { busy, error, pick } = usePick(scope, onClose);
  const lists = useLists(settings.connections, open);
  const anyZdr = settings.connections.some((c) => c.provider === 'openrouter' && c.zdr);
  const zdr = useOpenRouterZdrQuery(open && anyZdr);
  const input = { models: lists.models, connections: settings.connections, chip, query, route: settings.route, zdr: anyZdr ? (zdr.data ?? null) : null };
  const rows = scopedRows(pickRows(input), scope);
  const typed = typedRow({ ...input, chip: chipOf(settings, scope) });
  return (
    <Modal title={titleOf(scope)} open={open} onClose={onClose}>
      <Col gap={12}>
        <Input name="model-search" value={query} placeholder="Search models" dark={dark} onChangeText={setQuery} style={GROW} inputProps={{ autoFocus: true, autoCapitalize: 'none', autoComplete: 'off', autoCorrect: false, spellCheck: false }} />
        {lists.loading && rows.length === 0 ? <Text size="sm" role="secondary">Loading models…</Text> : null}
        {lists.errors.map((e) => (
          <Text key={e} size="sm" role="danger">{e}</Text>
        ))}
        {error === null ? null : <Text size="sm" role="danger">{error}</Text>}
        <Groups rows={rows} typed={typed} connections={settings.connections} busy={busy} onPick={pick} />
      </Col>
    </Modal>
  );
}
