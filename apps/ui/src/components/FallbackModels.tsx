import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { Icon } from './Icon.js';
import { KebabMenu } from './KebabMenu.js';
import { ProviderLogo } from './ProviderLogo.js';
import { SettingsGroup, SettingsSection } from './SettingsSection.js';
import { ModelPickerModal } from './ModelPickerModal.js';
import { useModelName } from './AgentModel.js';
import { holdLine, PROVIDERS, saveFallbacks, type ChainRow, type ConnectionRow, type Fallback, type ModelSettings } from '../api/model.js';
import type { PickRow } from '../api/providers.js';
import { queryError, refresh } from '../api/queries.js';

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
      <div className="provider-row-end">
        {row?.active === true ? <span className="tag">In use now</span> : null}
        <button type="button" className="kebab" aria-label={`Move ${name} up`} disabled={busy || first} onClick={() => { onMove(-1); }}>
          <Icon name="arrowUp" size={ARROW} color={palette.link} />
        </button>
        <button type="button" className="kebab" aria-label={`Move ${name} down`} disabled={busy || last} onClick={() => { onMove(1); }}>
          <Icon name="arrowDown" size={ARROW} color={palette.link} />
        </button>
        <KebabMenu label={`${name} menu`} items={[{ label: 'Remove', danger: true, onSelect: onRemove }]} />
      </div>
    </SettingsSection>
  );
}

function Rows({ settings, list, busy, run }: { settings: ModelSettings; list: Fallback[]; busy: boolean; run: (next: Fallback[]) => void }): ReactNode {
  if (list.length === 0)
    return (
      <div className="settings-row">
        <Text size="2xs" role="secondary">{NONE}</Text>
      </div>
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
        <div className="settings-pad">
          <Text size="2xs" role="secondary">{OLD}</Text>
        </div>
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
          <div className="settings-pad">
            <Text size="2xs" role="danger">{error}</Text>
          </div>
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
