import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { Switch } from '@stage-labs/kit/react-native/switch';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Icon } from './Icon.js';
import { FormField } from './FormField.js';
import { ProviderLogo } from './ProviderLogo.js';
import { ProviderSetup } from './ProviderModal.js';
import { RowButton } from './ModelPickerModal.js';
import { UsageBar, UsageShort } from './ModelUsage.js';
import { useStacked } from './SettingsSection.js';
import { connectionNote, mostUsed } from './ProviderCard.js';
import { PROVIDERS, type ConnectionRow, type ModelOption, type ModelSettings } from '@metro-labs/client/api/model';
import { pickRows, typedRow, type PickInput, type PickRow } from '@metro-labs/client/api/providers';
import type { RouteDraft, Slot } from '@metro-labs/client/api/route-edit';
import { queryError, useAccountOf, useConnectionModelsQuery } from '../lib/queries.js';
import { GROW } from '../lib/style.js';
import { useHover } from './ui/hover.js';

const MARK = 24;
const LOGO = 20;
const LIST = { maxHeight: 300 } as const;
const OPTION = { paddingVertical: 10, paddingHorizontal: 12, borderWidth: 1, borderRadius: 10 } as const;
const ZDR_NOTE = 'Only providers that keep no prompts. The list shows only models that have one.';

function Mark({ n, open, done }: { n: number; open: boolean; done: boolean }): ReactNode {
  const palette = useKitPalette();
  const filled = open || done;
  const style = { width: MARK, height: MARK, borderRadius: MARK / 2, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: filled ? palette.text : palette.border, backgroundColor: filled ? palette.text : 'transparent' } as const;
  return (
    <View style={style}>
      {done && !open ? <Icon name="check" size={14} color={palette.bg} /> : <Text size="4xs" weight="semibold" color={filled ? palette.bg : palette.sub}>{String(n)}</Text>}
    </View>
  );
}

interface StepProps {
  n: number;
  title: string;
  value: string;
  open: boolean;
  done: boolean;
  last?: boolean;
  locked?: boolean;
  onOpen: () => void;
  children: ReactNode;
}

export function Step({ n, title, value, open, done, last = false, locked = false, onOpen, children }: StepProps): ReactNode {
  const palette = useKitPalette();
  const line = { flex: 1, width: 1, marginTop: 4, backgroundColor: palette.border } as const;
  return (
    <Row gap={12} align="stretch">
      <Col align="center" width={MARK}>
        <Mark n={n} open={open} done={done} />
        {last ? null : <View style={line} />}
      </Col>
      <Col flex={1} minWidth={0} gap={12} padding={{ bottom: last ? 4 : 20 }}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} disabled={open || locked} onPress={onOpen}>
          <Row align="center" gap={8} minHeight={MARK}>
            <Col flex={1} minWidth={0} gap={2}>
              <Text size="xs" weight="medium">{title}</Text>
              {open ? null : <Text size="2xs" role="secondary" numberOfLines={1}>{value}</Text>}
            </Col>
            {open || locked ? null : <Text size="2xs" role="link">Change</Text>}
          </Row>
        </Pressable>
        {open ? children : null}
      </Col>
    </Row>
  );
}

function Radio({ on }: { on: boolean }): ReactNode {
  const palette = useKitPalette();
  const ring = { width: 18, height: 18, borderRadius: 9, borderWidth: on ? 5 : 1.5, borderColor: on ? palette.text : palette.sub } as const;
  return <View style={ring} />;
}

function ConnectionOption({ conn, settings, on, onPick }: { conn: ConnectionRow; settings: ModelSettings; on: boolean; onPick: (id: string) => void }): ReactNode {
  const palette = useKitPalette();
  const compact = useStacked();
  const [hovered, hover] = useHover();
  const note = connectionNote(conn, useAccountOf(conn));
  const border = { borderColor: on ? palette.text : hovered ? palette.sub : palette.border };
  return (
    <Pressable accessibilityRole="radio" accessibilityState={{ checked: on }} {...hover} style={[OPTION, border]} onPress={() => { onPick(conn.id); }}>
      <Row gap={12} align="center">
        <Radio on={on} />
        <ProviderLogo provider={PROVIDERS.find((p) => p.id === conn.provider)} size={LOGO} />
        <Col flex={1} minWidth={0} gap={2}>
          <Text size="xs" weight="medium" numberOfLines={1}>{conn.label}</Text>
          {note === '' ? null : <Text size="2xs" role="secondary" numberOfLines={1}>{note}</Text>}
        </Col>
        {compact ? <UsageShort used={mostUsed(settings, conn.id)} /> : <UsageBar used={mostUsed(settings, conn.id)} />}
      </Row>
    </Pressable>
  );
}

function AddRow({ onPress }: { onPress: () => void }): ReactNode {
  const palette = useKitPalette();
  const [hovered, hover] = useHover();
  return (
    <Pressable accessibilityRole="button" {...hover} style={[OPTION, { borderStyle: 'dashed', borderColor: hovered ? palette.sub : palette.border }]} onPress={onPress}>
      <Row gap={12} align="center">
        <Icon name="plus" size={18} color={palette.link} />
        <Text size="xs" weight="medium" role="link">Add a connection</Text>
      </Row>
    </Pressable>
  );
}

export function ConnectionStep({ settings, draft, onPick }: { settings: ModelSettings; draft: RouteDraft; onPick: (id: string) => void }): ReactNode {
  const none = settings.connections.length === 0;
  const [adding, setAdding] = useState(none);
  const known = useRef<string[] | null>(none ? [] : null);
  useEffect(() => {
    const before = known.current;
    if (before === null) return;
    const fresh = settings.connections.find((c) => !before.includes(c.id));
    if (fresh === undefined) return;
    known.current = null;
    setAdding(false);
    onPick(fresh.id);
  }, [settings.connections, onPick]);
  if (adding)
    return (
      <ProviderSetup
        onDone={() => { setAdding(false); }}
        onBack={none ? undefined : () => { known.current = null; setAdding(false); }}
      />
    );
  return (
    <Col gap={8}>
      {settings.connections.map((c) => (
        <ConnectionOption key={c.id} conn={c} settings={settings} on={c.id === draft.connection} onPick={onPick} />
      ))}
      <AddRow onPress={() => { known.current = settings.connections.map((c) => c.id); setAdding(true); }} />
    </Col>
  );
}

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
      <ScrollView style={LIST} nestedScrollEnabled>
        <Col>
          {typed === null ? null : <RowButton row={{ ...typed, name: `Use “${typed.id}”` }} onPick={pick} />}
          {rows.map((row) => (
            <RowButton key={row.id === '' ? 'default' : row.id} row={row} onPick={pick} />
          ))}
        </Col>
      </ScrollView>
    </Col>
  );
}
