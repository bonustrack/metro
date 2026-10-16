import { type ReactNode, useState } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { ModelStep } from './ModelStep.js';
import { nameIn } from './AgentModel.js';
import { connectionNote } from './ProviderCard.js';
import { ConnectionStep, Step } from './RouteSteps.js';
import { Actions } from './ui/Actions.js';
import { Readable } from './ui/Layout.js';
import type { ConnectionRow } from '@metro-labs/client/api/model';
import type { ModelRoute, RouteStep } from '@metro-labs/client/api/model-route';
import { changesOf, draftOf, problemOf, routeAfter, slotTitle, withConnection, type RouteChange, type Slot } from '@metro-labs/client/api/route-edit';
import { queryError } from '../lib/queries.js';
import { useConnectionModelsQuery } from '../lib/model-queries.js';

type Open = 'connection' | 'model';

const NO_CHANGE = 'Nothing changed yet.';

export interface RouteScope {
  route: ModelRoute | null;
  connections: ConnectionRow[];
  empty: ReactNode;
  save: (route: ModelRoute) => Promise<void>;
}

interface FooterProps {
  changes: RouteChange[];
  problem: string | null;
  error: string | null;
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
}

function Footer({ changes, problem, error, busy, onSave, onCancel }: FooterProps): ReactNode {
  const ready = changes.length > 0 && problem === null;
  return (
    <Col gap={12}>
      {changes.length === 0 ? <Text size="xs" role="secondary">{NO_CHANGE}</Text> : (
        <Col gap={4}>
          {changes.map((c) => (
            <Text key={c.label} size="xs" numberOfLines={2}>{c.from === '' ? `${c.label}: ${c.to}` : `${c.label}: ${c.from} → ${c.to}`}</Text>
          ))}
        </Col>
      )}
      {problem === null ? null : <Text size="xs" role="danger">{problem}</Text>}
      <Actions error={error} cancel={{ onPress: onCancel, disabled: busy }} main={{ label: busy ? 'Saving…' : 'Save', busy, disabled: !ready, onPress: onSave }} />
    </Col>
  );
}

function useNames(scope: RouteScope, slot: Slot, draft: RouteStep): (connection: string, model: string) => string {
  const start = draftOf(scope.route, slot);
  const before = useConnectionModelsQuery(scope.connections.find((c) => c.id === start.connection));
  const after = useConnectionModelsQuery(scope.connections.find((c) => c.id === draft.connection));
  return (connection, model) => nameIn(connection === draft.connection ? after.data : before.data, model);
}

function useSave(scope: RouteScope, slot: Slot, draft: RouteStep, onClose: () => void): { busy: boolean; error: string | null; save: () => void } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = (): void => {
    setBusy(true);
    setError(null);
    scope.save(routeAfter(scope.route, slot, draft))
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

function connectionValue(conn: ConnectionRow | undefined): string {
  if (conn === undefined) return 'Choose where requests go';
  const note = connectionNote(conn);
  return note === '' ? conn.label : `${conn.label} · ${note}`;
}

function modelValue(draft: RouteStep, slot: Slot, name: (connection: string, model: string) => string): string {
  if (draft.connection === '' || (draft.model === '' && slot.kind !== 'primary')) return 'Choose a model';
  return name(draft.connection, draft.model);
}

export function RouteEditor({ scope, slot, onClose }: { scope: RouteScope; slot: Slot; onClose: () => void }): ReactNode {
  const [draft, setDraft] = useState<RouteStep>(() => draftOf(scope.route, slot));
  const [open, setOpen] = useState<Open>(scope.connections.some((c) => c.id === draft.connection) ? 'model' : 'connection');
  const conn = scope.connections.find((c) => c.id === draft.connection);
  const name = useNames(scope, slot, draft);
  const listed = useConnectionModelsQuery(conn);
  const problem = problemOf(scope.route, scope.connections, slot, draft, listed.data);
  const { busy, error, save } = useSave(scope, slot, draft, onClose);
  const pickConnection = (id: string): void => {
    setDraft(withConnection(scope.connections, id));
    setOpen('model');
  };
  return (
    <Readable gap={16}>
      <Text accessibilityRole="header" size="xs" role="secondary">{slotTitle(slot)}</Text>
      <Col>
        <Step n={1} title="Connection" value={connectionValue(conn)} open={open === 'connection'} done={conn !== undefined} onOpen={() => { setOpen('connection'); }}>
          <ConnectionStep connections={scope.connections} draft={draft} empty={scope.empty} onPick={pickConnection} />
        </Step>
        <Step n={2} title="Model" value={modelValue(draft, slot, name)} open={open === 'model' && conn !== undefined} done={conn !== undefined && problem === null} last locked={conn === undefined} onOpen={() => { setOpen('model'); }}>
          {conn === undefined ? null : <ModelStep conn={conn} model={draft.model} onPick={(model) => { setDraft((d) => ({ ...d, model })); }} />}
        </Step>
      </Col>
      <Footer changes={changesOf(scope.route, scope.connections, slot, draft, name)} problem={conn === undefined ? null : problem} error={error} busy={busy} onSave={save} onCancel={onClose} />
    </Readable>
  );
}
