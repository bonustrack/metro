import { ModelStep } from './ModelStep.js';
import { type ReactNode, useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Modal } from './Modal.js';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { nameIn } from './AgentModel.js';
import { connectionNote } from './ProviderCard.js';
import { ConnectionStep, Step } from './RouteSteps.js';
import { useStacked } from './SettingsSection.js';
import type { ConnectionRow, ModelSettings } from '@metro-labs/client/api/model';
import { changesOf, draftOf, problemOf, saveRoute, sharesConnection, slotTitle, withConnection, type RouteChange, type RouteDraft, type Slot } from '@metro-labs/client/api/route-edit';
import { queryError, refresh, useAccountOf, useConnectionModelsQuery, useOpenRouterZdrQuery } from '../lib/queries.js';

type Open = 'connection' | 'model';

const RESTART = 'Saving restarts the agent, which takes a few seconds.';
const NO_CHANGE = 'Nothing changed yet.';

interface FooterProps {
  changes: RouteChange[];
  problem: string | null;
  error: string | null;
  busy: boolean;
  restart: boolean;
  onSave: () => void;
  onCancel: () => void;
}

function Footer({ changes, problem, error, busy, restart, onSave, onCancel }: FooterProps): ReactNode {
  const palette = useKitPalette();
  const dark = useKitScheme() === 'dark';
  const ready = changes.length > 0 && problem === null && !busy;
  return (
    <Col gap={10} padding={{ x: 16, top: 14 }} border={{ top: { width: 1, color: palette.border } }}>
      {changes.length === 0 ? <Text size="2xs" role="secondary">{NO_CHANGE}</Text> : (
        <Col gap={4}>
          {changes.map((c) => (
            <Text key={c.label} size="2xs" numberOfLines={2}>{c.from === '' ? `${c.label}: ${c.to}` : `${c.label}: ${c.from} → ${c.to}`}</Text>
          ))}
        </Col>
      )}
      {problem !== null ? <Text size="2xs" role="danger">{problem}</Text> : restart && changes.length > 0 ? <Text size="2xs" role="secondary">{RESTART}</Text> : null}
      {error === null ? null : <Text size="2xs" role="danger">{error}</Text>}
      <Row gap={8} justify="end">
        <Button size="md" color="secondary" dark={dark} label="Cancel" onPress={onCancel} />
        <Button size="md" dark={dark} label={busy ? 'Saving…' : 'Save'} loading={busy} disabled={!ready} onPress={onSave} />
      </Row>
    </Col>
  );
}

function useNames(settings: ModelSettings, slot: Slot, draft: RouteDraft): (connection: string, model: string) => string {
  const start = draftOf(settings, slot);
  const before = useConnectionModelsQuery(settings.connections.find((c) => c.id === start.connection));
  const after = useConnectionModelsQuery(settings.connections.find((c) => c.id === draft.connection));
  return (connection, model) => nameIn(connection === draft.connection ? after.data : before.data, model);
}

function useSave(settings: ModelSettings, slot: Slot, draft: RouteDraft, onClose: () => void): { busy: boolean; error: string | null; save: () => void } {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = (): void => {
    setBusy(true);
    setError(null);
    saveRoute(settings, slot, draft)
      .then(() => refresh(client, 'model'))
      .then(onClose)
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not save.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return { busy, error, save };
}

function connectionValue(conn: ConnectionRow | undefined, account: string | null): string {
  if (conn === undefined) return 'Choose where requests go';
  const note = connectionNote(conn, account);
  return note === '' ? conn.label : `${conn.label} · ${note}`;
}

function useZdr(conn: ConnectionRow | undefined, draft: RouteDraft): { on: boolean; set: Set<string> | null } {
  const on = conn?.provider === 'openrouter' && draft.zdr;
  const zdr = useOpenRouterZdrQuery(on);
  return { on, set: on ? (zdr.data ?? null) : null };
}

function modelValue(draft: RouteDraft, slot: Slot, name: (connection: string, model: string) => string, zdr: boolean): string {
  if (draft.connection === '' || (draft.model === '' && slot.kind !== 'primary')) return 'Choose a model';
  return [name(draft.connection, draft.model), zdr ? 'zero data retention' : ''].filter((x) => x !== '').join(' · ');
}

function Editor({ settings, slot, onClose }: { settings: ModelSettings; slot: Slot; onClose: () => void }): ReactNode {
  const sheet = useStacked();
  const [draft, setDraft] = useState<RouteDraft>(() => draftOf(settings, slot));
  const [open, setOpen] = useState<Open>(slot.kind === 'new' || !settings.connections.some((c) => c.id === draft.connection) ? 'connection' : 'model');
  const conn = settings.connections.find((c) => c.id === draft.connection);
  const account = useAccountOf(conn);
  const zdr = useZdr(conn, draft);
  const name = useNames(settings, slot, draft);
  const problem = problemOf(settings, slot, draft, zdr.set);
  const { busy, error, save } = useSave(settings, slot, draft, onClose);
  const pickConnection = useCallback((id: string, saved?: RouteDraft) => {
    setDraft(saved ?? withConnection(settings, id));
    setOpen('model');
  }, [settings]);
  const footer = <Footer changes={changesOf(settings, slot, draft, name)} problem={conn === undefined ? null : problem} error={error} busy={busy} restart={slot.kind === 'primary'} onSave={save} onCancel={onClose} />;
  return (
    <Modal title={slotTitle(slot)} open onClose={onClose} footer={footer} side={sheet ? 'bottom' : 'center'}>
      <Col padding={{ top: 4, bottom: 12 }}>
        <Step n={1} title="Connection" value={connectionValue(conn, account)} open={open === 'connection'} done={conn !== undefined} onOpen={() => { setOpen('connection'); }}>
          <ConnectionStep settings={settings} draft={draft} onPick={pickConnection} />
        </Step>
        <Step n={2} title="Model" value={modelValue(draft, slot, name, zdr.on)} open={open === 'model' && conn !== undefined} done={conn !== undefined && problem === null} last locked={conn === undefined} onOpen={() => { setOpen('model'); }}>
          {conn === undefined ? null : (
            <ModelStep
              conn={conn}
              slot={slot}
              draft={draft}
              zdr={zdr.set}
              shared={sharesConnection(settings, slot, conn.id)}
              onPick={(model) => { setDraft((d) => ({ ...d, model })); }}
              onZdr={(on) => { setDraft((d) => ({ ...d, zdr: on })); }}
            />
          )}
        </Step>
      </Col>
    </Modal>
  );
}

export function RouteEditor({ settings, slot, onClose }: { settings: ModelSettings; slot: Slot | null; onClose: () => void }): ReactNode {
  if (slot === null) return null;
  return <Editor settings={settings} slot={slot} onClose={onClose} />;
}
