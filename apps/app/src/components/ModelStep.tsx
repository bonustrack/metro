import { type ReactNode, useState } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Scroll } from '@stage-labs/kit/react-native/scroll';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { FormField } from './FormField.js';
import { RowButton } from './ModelRowButton.js';
import type { ConnectionRow } from '@metro-labs/client/api/model';
import { pickRows, typedRow, type PickInput, type PickRow } from '@metro-labs/client/api/providers';
import type { Slot } from '@metro-labs/client/api/route-edit';
import { queryError } from '../lib/queries.js';
import { useConnectionModelsQuery } from '../lib/model-queries.js';
import { GROW } from '../lib/style.js';

const LIST = { maxHeight: 300 } as const;

interface ModelStepProps {
  conn: ConnectionRow;
  slot: Slot;
  model: string;
  onPick: (model: string) => void;
}

function ListStatus({ loading, empty, error }: { loading: boolean; empty: boolean; error: string | null }): ReactNode {
  if (error !== null) return <Text size="md" role="danger">{error}</Text>;
  if (!empty) return null;
  return <Text size="md" role="secondary">{loading ? 'Loading models…' : 'No model matches your search.'}</Text>;
}

export function ModelStep({ conn, slot, model, onPick }: ModelStepProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [query, setQuery] = useState('');
  const models = useConnectionModelsQuery(conn);
  const input: PickInput = { models: models.data ?? [], connection: conn, query, current: model, named: slot.kind !== 'primary' };
  const rows = pickRows(input);
  const typed = typedRow(input);
  const pick = (row: PickRow): void => { onPick(row.id); };
  return (
    <Col gap={10}>
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
