import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { Icon } from './Icon.js';
import { KebabMenu } from './KebabMenu.js';
import { ProviderLogo } from './ProviderLogo.js';
import { SettingsGroup, SettingsPad, SettingsSection } from './SettingsSection.js';
import { ModelPickerModal } from './ModelPickerModal.js';
import { useModelName } from './AgentModel.js';
import { holdLine, PROVIDERS, saveFallbacks, type ChainRow, type ConnectionRow, type Fallback, type ModelSettings } from '@metro-labs/client/api/model';
import type { PickRow } from '@metro-labs/client/api/providers';
import { queryError, refresh } from '../lib/queries.js';
import { Tag } from './Tag.js';
import { RoundButton } from './RoundButton.js';
import { Row } from '@stage-labs/kit/react-native/box';

const NOTE = 'When a model passes 95% of its usage or hits its limit, the agent moves to the next one in this order, and back up once the usage resets.';
const NONE = 'No fallback yet. Add one so the agent keeps working when its model runs out.';
const OLD = 'Update Metro to use fallback models.';
const NAMED = 'Choose a named model for a fallback.';
const LOGO = 24;
const ARROW = 16;

const same = (a: Fallback, b: Fallback): boolean => a.connection === b.connection && a.model === b.model;

function statusLine(row: ChainRow | undefined): string {
  if (row === undefined) return '';
  if (row.hold !== null) return `Skipped: ${holdLine(row.hold)}`;
  return row.used === null ? '' : `${String(Math.round(row.used * 100))}% used`;
}

function moved(list: Fallback[], at: number, by: number): Fallback[] {
  const next = [...list];
  const [item] = next.splice(at, 1);
  if (item === undefined) return list;
  next.splice(Math.min(next.length, Math.max(0, at + by)), 0, item);
  return next;
}

interface RowProps {
  fallback: Fallback;
  connection: ConnectionRow;
  row: ChainRow | undefined;
  first: boolean;
  last: boolean;
  busy: boolean;
  onMove: (by: number) => void;
  onRemove: () => void;
}

function FallbackRow({ fallback, connection, row, first, last, busy, onMove, onRemove }: RowProps): ReactNode {
  const palette = useKitPalette();
  const name = useModelName(connection, fallback.model);
  const note = [connection.label, statusLine(row)].filter((part) => part !== '').join(' · ');
  return (
    <SettingsSection title={name} note={note} leading={<ProviderLogo provider={PROVIDERS.find((p) => p.id === connection.provider)} size={LOGO} />}>
      <Row align="center" gap={10}>
        {row?.active === true ? <Tag label="In use now" /> : null}
        <RoundButton label={`Move ${name} up`} disabled={busy || first} onPress={() => { onMove(-1); }}>
          <Icon name="arrowUp" size={ARROW} color={palette.link} />
        </RoundButton>
        <RoundButton label={`Move ${name} down`} disabled={busy || last} onPress={() => { onMove(1); }}>
          <Icon name="arrowDown" size={ARROW} color={palette.link} />
        </RoundButton>
        <KebabMenu label={`${name} menu`} items={[{ label: 'Remove', danger: true, onSelect: onRemove }]} />
      </Row>
    </SettingsSection>
  );
}

function Rows({ settings, list, busy, run }: { settings: ModelSettings; list: Fallback[]; busy: boolean; run: (next: Fallback[]) => void }): ReactNode {
  if (list.length === 0)
    return (
      <SettingsPad row>
        <Text size="2xs" role="secondary">{NONE}</Text>
      </SettingsPad>
    );
  return list.map((fallback, at) => {
    const connection = settings.connections.find((c) => c.id === fallback.connection);
    if (connection === undefined) return null;
    return (
      <FallbackRow
        key={`${fallback.connection}:${fallback.model}`}
        fallback={fallback}
        connection={connection}
        row={settings.chain.slice(1).find((r) => same(r, fallback))}
        first={at === 0}
        last={at === list.length - 1}
        busy={busy}
        onMove={(by) => { run(moved(list, at, by)); }}
        onRemove={() => { run(list.filter((_, other) => other !== at)); }}
      />
    );
  });
}

export function FallbackModels({ settings }: { settings: ModelSettings }): ReactNode {
  const client = useQueryClient();
  const dark = useKitScheme() === 'dark';
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (settings.connections.length === 0) return null;
  const list = settings.fallbacks;
  if (list === null)
    return (
      <SettingsGroup title="Fallbacks">
        <SettingsPad>
          <Text size="2xs" role="secondary">{OLD}</Text>
        </SettingsPad>
      </SettingsGroup>
    );
  const save = (next: Fallback[]): Promise<unknown> => saveFallbacks(next).then(() => refresh(client, 'model'));
  const run = (next: Fallback[]): void => {
    setBusy(true);
    setError(null);
    save(next)
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not save the fallback models.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  const add = (row: PickRow): Promise<unknown> => {
    if (row.id === '') return Promise.reject(new Error(NAMED));
    const picked = { connection: row.connection, model: row.id };
    return list.some((f) => same(f, picked)) ? Promise.resolve() : save([...list, picked]);
  };
  return (
    <>
      <SettingsGroup title="Fallbacks" note={NOTE} action={<Button size="md" dark={dark} label="Add fallback" disabled={busy} onPress={() => { setPicking(true); }} />}>
        <Rows settings={settings} list={list} busy={busy} run={run} />
        {error === null ? null : (
          <SettingsPad>
            <Text size="2xs" role="danger">{error}</Text>
          </SettingsPad>
        )}
      </SettingsGroup>
      <ModelPickerModal
        open={picking}
        settings={settings}
        title="Add a fallback model"
        isCurrent={(row) => list.some((f) => same(f, { connection: row.connection, model: row.id }))}
        onPick={add}
        onClose={() => { setPicking(false); }}
      />
    </>
  );
}
