import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Scroll } from '@stage-labs/kit/react-native/scroll';
import { Text } from '@stage-labs/kit/react-native/text';
import { Switch } from '@stage-labs/kit/react-native/switch';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Icon } from './Icon.js';
import { FormField } from './FormField.js';
import { RowButton } from './ModelPickerModal.js';
import { type ConnectionRow, type ModelOption } from '@metro-labs/client/api/model';
import { pickRows, typedRow, type PickInput, type PickRow } from '@metro-labs/client/api/providers';
import type { RouteDraft, Slot } from '@metro-labs/client/api/route-edit';
import { queryError, useConnectionModelsQuery } from '../lib/queries.js';
import { GROW } from '../lib/style.js';

const LIST = { maxHeight: 300 } as const;
const ZDR_NOTE = 'Only providers that keep no prompts. The list shows only models that have one.';

function ZdrSwitch({ conn, on, shared, onChange }: { conn: ConnectionRow; on: boolean; shared: boolean; onChange: (on: boolean) => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Col gap={6} padding={12} radius={10} surface="raised">
      <Row align="center" gap={12}>
        <Icon name="shieldCheck" size={18} color={useKitPalette().link} />
        <Col flex={1} minWidth={0} gap={2}>
          <Text size="xs" weight="medium">Zero data retention</Text>
          <Text size="2xs" role="secondary">{ZDR_NOTE}</Text>
        </Col>
        <Switch name="Zero data retention" checked={on} dark={dark} onChange={onChange} />
      </Row>
      {shared ? <Text size="2xs" role="secondary">{`A setting of the ${conn.label} connection: it also applies to the other models on the list that use it.`}</Text> : null}
    </Col>
  );
}

interface ModelStepProps {
  conn: ConnectionRow;
  slot: Slot;
  draft: RouteDraft;
  zdr: Set<string> | null;
  shared: boolean;
  onPick: (model: string) => void;
  onZdr: (on: boolean) => void;
}

function inputOf(conn: ConnectionRow, listed: ModelOption[] | undefined, on: boolean, zdr: Set<string> | null, query: string): PickInput {
  const filtered = conn.provider === 'openrouter' && on;
  return { models: { [conn.id]: listed ?? [] }, connections: [{ ...conn, zdr: filtered }], chip: conn.id, query, route: '', zdr: filtered ? zdr : null };
}

function visible(rows: PickRow[], slot: Slot, model: string): PickRow[] {
  const named = slot.kind === 'primary' ? rows : rows.filter((row) => row.id !== '');
  return named.map((row) => ({ ...row, current: row.id === model }));
}

function ListStatus({ loading, empty, error }: { loading: boolean; empty: boolean; error: string | null }): ReactNode {
  if (error !== null) return <Text size="2xs" role="danger">{error}</Text>;
  if (!empty) return null;
  return <Text size="2xs" role="secondary">{loading ? 'Loading models…' : 'No model matches your search.'}</Text>;
}

export function ModelStep({ conn, slot, draft, zdr, shared, onPick, onZdr }: ModelStepProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [query, setQuery] = useState('');
  const models = useConnectionModelsQuery(conn);
  const input = inputOf(conn, models.data, draft.zdr, zdr, query);
  const rows = visible(pickRows(input), slot, draft.model);
  const typed = typedRow(input);
  const pick = (row: PickRow): void => { onPick(row.id); };
  return (
    <Col gap={10}>
      {conn.provider === 'openrouter' ? <ZdrSwitch conn={conn} on={draft.zdr} shared={shared} onChange={onZdr} /> : null}
      <FormField label="Search models" name="route-model-search" value={query} placeholder="Name or id" dark={dark} onChangeText={setQuery} style={GROW} inputProps={{ autoCapitalize: 'none', autoComplete: 'off', autoCorrect: false, spellCheck: false }} />
      <ListStatus loading={models.isFetching} empty={rows.length === 0 && typed === null} error={models.error === null ? null : queryError(models.error, `Could not list the models of ${conn.label}.`)} />
      <Scroll style={LIST} nestedScrollEnabled>
        <Col>
          {typed === null ? null : <RowButton row={{ ...typed, name: `Use “${typed.id}”` }} onPick={pick} />}
          {rows.map((row) => (
            <RowButton key={row.id === '' ? 'default' : row.id} row={row} onPick={pick} />
          ))}
        </Col>
      </Scroll>
    </Col>
  );
}
