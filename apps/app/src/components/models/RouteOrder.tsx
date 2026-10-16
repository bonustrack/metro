import { type ReactNode } from 'react';
import type { ModelOrderItem } from '@metro-labs/client/api/model-order';
import { canAddFallback } from '@metro-labs/client/api/route-edit';
import { Group } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { RouteEditor, type RouteScope } from '../RouteEditor.js';
import type { RouteActions, RouteControl } from '../route-actions.js';
import { NoteRow } from '../settings/rows.js';
import { AddRow, ModelRow, backupMenu } from './RouteRows.js';
import { useTechnicalDetails } from '../../lib/technical.js';

export interface RouteEdit {
  control: RouteControl;
  scope: RouteScope;
}

interface RouteOrderProps {
  items: ModelOrderItem[];
  who: string;
  mainNote?: string;
  error?: string | null;
  edit?: RouteEdit;
}

const rowKey = (item: ModelOrderItem): string => (item.slot.kind === 'fallback' ? `${String(item.slot.at)}:${item.step.connection}:${item.model}` : 'main');

const backupNote = (who: string): string => `${who} moves on when a model passes 95% or is full, and comes back when it resets.`;

const actionsOf = (edit: RouteEdit | undefined): RouteActions | undefined => (edit === undefined || edit.control.busy ? undefined : edit.control.actions);

function MainRow({ item, edit }: { item: ModelOrderItem | undefined; edit: RouteEdit | undefined }): ReactNode {
  const technical = useTechnicalDetails();
  const actions = actionsOf(edit);
  const choose = (): void => {
    edit?.control.actions.edit({ kind: 'primary' });
  };
  if (item !== undefined) return <ModelRow item={item} technical={technical} onPress={actions === undefined ? undefined : choose} />;
  if (edit === undefined) return <Item title="No model yet" />;
  return <AddRow label="Choose a model" disabled={edit.control.busy} onPress={choose} />;
}

function Backups({ items, who, edit }: { items: ModelOrderItem[]; who: string; edit: RouteEdit | undefined }): ReactNode {
  const technical = useTechnicalDetails();
  const actions = actionsOf(edit);
  if (items.length === 0 && edit === undefined) return null;
  return (
    <Group label="Backups, in order" note={backupNote(who)}>
      {items.map((item, at) => (
        <ModelRow key={rowKey(item)} item={item} technical={technical} menu={actions === undefined ? undefined : backupMenu(at, at === items.length - 1, actions)} />
      ))}
      {edit === undefined ? null : (
        <AddRow label="Add a backup" disabled={edit.control.busy || !canAddFallback(edit.scope.route)} onPress={() => { edit.control.actions.edit({ kind: 'new' }); }} />
      )}
    </Group>
  );
}

export function RouteOrder({ items, who, mainNote, error = null, edit }: RouteOrderProps): ReactNode {
  if (edit !== undefined && edit.control.slot !== null) return <RouteEditor scope={edit.scope} slot={edit.control.slot} onClose={edit.control.close} />;
  const [main, ...backups] = items;
  const problem = edit?.control.error ?? error;
  return (
    <>
      <Group label="Main model" note={mainNote}>
        <MainRow item={main} edit={edit} />
        {problem === null ? null : <NoteRow text={problem} danger />}
      </Group>
      {main === undefined ? null : <Backups items={backups} who={who} edit={edit} />}
    </>
  );
}
