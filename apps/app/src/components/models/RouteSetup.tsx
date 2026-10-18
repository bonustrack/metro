import { type ReactNode } from 'react';
import type { ModelOrderItem } from '@metro-labs/client/api/model-order';
import { EFFORT_LEVELS, effortOf, withEffort, withHelpers, type EffortLevel, type EffortThread, type ModelRoute, type RouteEffort } from '@metro-labs/client/api/model-route';
import { helperSlotTitle } from '@metro-labs/client/api/route-edit';
import { RouteEditor, type RouteScope } from '../RouteEditor.js';
import { useRouteControl, type RouteControl } from '../route-actions.js';
import { Group } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { ValueMenu } from '../ValueMenu.js';
import { Check } from './RouteParts.js';
import { RouteOrder, type OrderLabels, type RouteEdit } from './RouteOrder.js';
import { EFFORT_WORD } from '../../lib/model-words.js';

const HELPERS_NOTE = 'Helpers are the workers the agent starts for longer tasks.';
const EFFORT_NOTE = 'As the agent asks leaves the effort to the agent.';
const HELPER_LABELS: OrderLabels = { main: 'Helper model', backups: 'Helper backups, in order' };
const SAME = { title: 'Same as the main model', subtitle: 'Helpers use the main model and its backups' };
const OTHER = { title: 'Other models', subtitle: 'The models below' };

const THREADS: { thread: EffortThread; title: string; note: string; label: string }[] = [
  { thread: 'main', title: 'Main thread', note: 'Low by default, so it answers fast.', label: 'Effort of the main thread' },
  { thread: 'helpers', title: 'Helpers', note: 'Max by default, so they think hard.', label: 'Effort of the helpers' },
];

interface RouteSetupProps {
  items: ModelOrderItem[];
  helperItems: ModelOrderItem[] | null;
  effort: RouteEffort;
  who: string;
  mainNote?: string;
  error?: string | null;
  edit?: RouteEdit;
}

interface Parts {
  route: ModelRoute;
  save: (route: ModelRoute) => Promise<void>;
  helpers: RouteEdit;
  effort: RouteControl;
  busy: boolean;
}

interface Saving {
  route: ModelRoute | null;
  save: (route: ModelRoute) => Promise<void>;
}

interface Target {
  route: ModelRoute;
  save: (route: ModelRoute) => Promise<void>;
  helpers: RouteScope;
}

const IDLE: Saving = { route: null, save: () => Promise.resolve() };

function targetOf(scope: RouteScope | undefined): Target | null {
  const route = scope?.route ?? null;
  if (scope === undefined || route === null) return null;
  const helpers: RouteScope = { route: route.helpers ?? null, connections: scope.connections, empty: scope.empty, title: helperSlotTitle, save: (chain) => scope.save(withHelpers(route, chain)) };
  return { route, save: scope.save, helpers };
}

function useParts(edit: RouteEdit | undefined): Parts | null {
  const target = targetOf(edit?.scope);
  const helperSaving: Saving = target?.helpers ?? IDLE;
  const saving: Saving = target ?? IDLE;
  const helpers = useRouteControl(helperSaving.route, helperSaving.save);
  const effort = useRouteControl(saving.route, saving.save);
  if (edit === undefined || target === null) return null;
  return { route: target.route, save: target.save, helpers: { control: helpers, scope: target.helpers }, effort, busy: edit.control.busy || helpers.busy || effort.busy };
}

function HelperChoice({ own, parts }: { own: boolean; parts: Parts | null }): ReactNode {
  if (parts === null) return <Item {...(own ? OTHER : SAME)} />;
  const { route, save, helpers, busy } = parts;
  const toSame = (): void => {
    helpers.control.run(() => save(withHelpers(route, null)), 'Could not change the helper models.');
  };
  const toOwn = (): void => {
    helpers.control.actions.edit({ kind: 'primary' });
  };
  return (
    <>
      <Item {...SAME} trailing={own ? undefined : <Check />} chevron={false} onPress={own && !busy ? toSame : undefined} />
      <Item title={OTHER.title} subtitle={own ? OTHER.subtitle : 'A model and backups just for helpers'} trailing={own ? <Check /> : undefined} chevron={false} onPress={own || busy ? undefined : toOwn} />
    </>
  );
}

function Helpers({ items, parts }: { items: ModelOrderItem[] | null; parts: Parts | null }): ReactNode {
  const own = items !== null;
  return (
    <>
      <Group label="Helpers" note={HELPERS_NOTE} error={own ? null : (parts?.helpers.control.error ?? null)}>
        <HelperChoice own={own} parts={parts} />
      </Group>
      {items === null ? null : <RouteOrder items={items} who="A helper" labels={HELPER_LABELS} edit={parts?.helpers} />}
    </>
  );
}

function EffortMenu({ thread, current, label, parts }: { thread: EffortThread; current: EffortLevel; label: string; parts: Parts }): ReactNode {
  const pick = (level: EffortLevel): void => {
    if (level !== current && !parts.busy) parts.effort.run(() => parts.save(withEffort(parts.route, thread, level)), 'Could not change the effort.');
  };
  const items = EFFORT_LEVELS.map((level) => ({ label: EFFORT_WORD[level], selected: level === current, onSelect: () => { pick(level); } }));
  return <ValueMenu items={items} label={label} value={EFFORT_WORD[current]} />;
}

function Effort({ effort, parts }: { effort: RouteEffort; parts: Parts | null }): ReactNode {
  return (
    <Group label="Effort" note={EFFORT_NOTE} error={parts?.effort.error ?? null}>
      {THREADS.map(({ thread, title, note, label }) => {
        const current = effortOf(effort, thread);
        const menu = parts === null ? undefined : <EffortMenu thread={thread} current={current} label={label} parts={parts} />;
        return <Item key={thread} title={title} subtitle={note} value={parts === null ? EFFORT_WORD[current] : undefined} trailing={menu} />;
      })}
    </Group>
  );
}

export function RouteSetup({ items, helperItems, effort, who, mainNote, error, edit }: RouteSetupProps): ReactNode {
  const parts = useParts(edit);
  const helperSlot = parts?.helpers.control.slot ?? null;
  if (parts !== null && helperSlot !== null) return <RouteEditor scope={parts.helpers.scope} slot={helperSlot} onClose={parts.helpers.control.close} />;
  if (edit !== undefined && edit.control.slot !== null) return <RouteEditor scope={edit.scope} slot={edit.control.slot} onClose={edit.control.close} />;
  return (
    <>
      <RouteOrder items={items} who={who} mainNote={mainNote} error={error} edit={edit} />
      {items.length === 0 ? null : (
        <>
          <Helpers items={helperItems} parts={parts} />
          <Effort effort={effort} parts={parts} />
        </>
      )}
    </>
  );
}
