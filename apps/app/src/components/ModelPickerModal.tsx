import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Icon } from './Icon.js';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { FormField } from './FormField.js';
import { Text } from '@stage-labs/kit/react-native/text';
import { Modal } from '@stage-labs/kit/react-native/modal';
import { ProviderLogo } from './ProviderLogo.js';
import { priceLabel, PROVIDERS, saveConnection, chooseConnection, type ConnectionRow, type ModelOption, type ModelSettings } from '@metro-labs/client/api/model';
import { pickRows, typedRow, type PickRow } from '@metro-labs/client/api/providers';
import { queryError, refresh, useConnectionModelsQuery, useOpenRouterZdrQuery } from '../lib/queries.js';
import { GROW } from '../lib/style.js';
import { Pressable, ScrollView } from 'react-native';
import { useHover } from './ui/hover.js';
import { Col, Row } from '@stage-labs/kit/react-native/box';

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

const LIST = { maxHeight: 520 } as const;
const BUSY = { opacity: 0.5 } as const;
const PICK_ROW = { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 67, paddingVertical: 9, paddingHorizontal: 16, borderRadius: 4 } as const;

function RowButton({ row, onPick }: { row: PickRow; onPick: (row: PickRow) => void }): ReactNode {
  const palette = useKitPalette();
  const [hovered, hover] = useHover();
  const lit = row.current || hovered ? { backgroundColor: palette.inputBg } : null;
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: row.current }} {...hover} style={[PICK_ROW, lit]} onPress={() => { onPick(row); }}>
      <Col gap={2} flex={1} minWidth={0}>
        <Text size="md" weight="semibold" role="link" numberOfLines={1}>
          {niceName(row)}
        </Text>
        <Text size="2xs" role="secondary" numberOfLines={1}>
          {rowDetail(row)}
        </Text>
      </Col>
      {row.current ? <Icon name="check" size={18} color={palette.link} /> : null}
    </Pressable>
  );
}

function Groups({ rows, typed, connections, busy, onPick }: { rows: PickRow[]; typed: PickRow | null; connections: ConnectionRow[]; busy: boolean; onPick: (row: PickRow) => void }): ReactNode {
  if (rows.length === 0 && typed === null)
    return (
      <Text size="2xs" role="secondary">
        No model matches your search.
      </Text>
    );
  return (
    <ScrollView style={LIST} nestedScrollEnabled pointerEvents={busy ? 'none' : 'auto'}>
      <Col gap={16} style={busy ? BUSY : undefined}>
        {typed === null ? null : <RowButton row={{ ...typed, name: `Use “${typed.id}”` }} onPick={onPick} />}
        {connections.map((c) => {
          const mine = rows.filter((row) => row.connection === c.id);
          if (mine.length === 0) return null;
          return (
            <Col key={c.id}>
              <Row align="center" gap={8} padding={{ y: 6 }}>
                <ProviderLogo provider={PROVIDERS.find((p) => p.id === c.provider)} size={LOGO} />
                <Text size="2xs" role="secondary">
                  {c.label}
                </Text>
              </Row>
              {mine.map((row) => (
                <RowButton key={`${row.connection}:${row.id}`} row={row} onPick={onPick} />
              ))}
            </Col>
          );
        })}
      </Col>
    </ScrollView>
  );
}

type OnPick = (row: PickRow) => Promise<unknown>;

function usePick(scope: ConnectionRow | undefined, onClose: () => void, onPick?: OnPick): { busy: boolean; error: string | null; pick: (row: PickRow) => void } {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const routeTo: OnPick = (row) =>
    saveConnection(row.connection, { model: row.id })
      .then(() => (scope === undefined ? chooseConnection(row.connection) : undefined))
      .then(() => refresh(client, 'model'));
  const pick = (row: PickRow): void => {
    setBusy(true);
    setError(null);
    (onPick ?? routeTo)(row)
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

const titleOf = (scope: ConnectionRow | undefined, title: string | undefined): string =>
  title ?? (scope === undefined ? 'Choose a model' : `Model for ${scope.label}`);

function scopedRows(rows: PickRow[], scope: ConnectionRow | undefined, isCurrent: ((row: PickRow) => boolean) | undefined): PickRow[] {
  if (isCurrent !== undefined) return rows.map((row) => ({ ...row, current: isCurrent(row) }));
  return scope === undefined ? rows : rows.map((row) => ({ ...row, current: row.id === scope.model }));
}

interface PickerProps {
  open: boolean;
  settings: ModelSettings;
  scope?: ConnectionRow;
  title?: string;
  isCurrent?: (row: PickRow) => boolean;
  onPick?: OnPick;
  onClose: () => void;
}

export function ModelPickerModal({ open, settings, scope, title, isCurrent, onPick, onClose }: PickerProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [query, setQuery] = useState('');
  const chip = scope?.id ?? 'all';
  const { busy, error, pick } = usePick(scope, onClose, onPick);
  const lists = useLists(settings.connections, open);
  const anyZdr = settings.connections.some((c) => c.provider === 'openrouter' && c.zdr);
  const zdr = useOpenRouterZdrQuery(open && anyZdr);
  const input = { models: lists.models, connections: settings.connections, chip, query, route: settings.route, zdr: anyZdr ? (zdr.data ?? null) : null };
  const rows = scopedRows(pickRows(input), scope, isCurrent);
  const typed = typedRow({ ...input, chip: chipOf(settings, scope) });
  return (
    <Modal title={titleOf(scope, title)} open={open} onClose={onClose}>
      <Col gap={12}>
        <FormField label="Search models" name="model-search" value={query} placeholder="Search models" dark={dark} onChangeText={setQuery} style={GROW} inputProps={{ autoFocus: true, autoCapitalize: 'none', autoComplete: 'off', autoCorrect: false, spellCheck: false }} />
        {lists.loading && rows.length === 0 ? <Text size="2xs" role="secondary">Loading models…</Text> : null}
        {lists.errors.map((e) => (
          <Text key={e} size="2xs" role="danger">{e}</Text>
        ))}
        {error === null ? null : <Text size="2xs" role="danger">{error}</Text>}
        <Groups rows={rows} typed={typed} connections={settings.connections} busy={busy} onPick={pick} />
      </Col>
    </Modal>
  );
}
