import { type ReactNode } from 'react';
import { Row } from '@stage-labs/kit/react-native/row';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Icon } from '../../Icon.js';
import { Spinner } from '../../Spinner.js';
import { Group } from '../../ui/Group.js';
import { Item } from '../../ui/Item.js';
import { ICON_SIZE } from '../../ui/sizes.js';
import type { ActionId, MoveAction, StatusWords, SummaryLine } from '../../../lib/mail-move.js';

const MARK = ICON_SIZE.lg;
const TEXT_LINES = 8;

function Mark({ done, running }: { done: boolean; running: boolean }): ReactNode {
  const palette = useKitPalette();
  return (
    <Row width={MARK} height={MARK} align="center" justify="center">
      {running ? <Spinner color={palette.link} /> : done ? <Icon name="check" size={ICON_SIZE.md} color={palette.success} /> : null}
    </Row>
  );
}

const stateOf = (action: MoveAction, running: boolean): string => (running ? 'in progress' : action.done ? 'done' : 'to do');

export function MoveSteps({ actions, running }: { actions: readonly MoveAction[]; running: ActionId | null }): ReactNode {
  return (
    <Group label="Steps">
      {actions.map((action) => {
        const now = running === action.id;
        return <Item key={action.id} title={action.title} detail={action.text} detailLines={TEXT_LINES} label={`${action.title}: ${stateOf(action, now)}`} trailing={<Mark done={action.done} running={now} />} chevron={false} />;
      })}
    </Group>
  );
}

export function SummaryGroup({ label, lines }: { label: string; lines: readonly SummaryLine[] }): ReactNode {
  return (
    <Group label={label}>
      {lines.map((line, at) => (
        <Item key={`${String(at)}:${line.title}`} title={line.title} detail={line.text} detailTone={line.tone} detailLines={TEXT_LINES} value={line.value} chevron={false} />
      ))}
    </Group>
  );
}

export function MailStatus({ words, note }: { words: StatusWords | null; note?: string }): ReactNode {
  if (words === null) return null;
  return (
    <Group label="Mail" note={note}>
      <Item title={words.title} detail={words.text} detailTone={words.tone} detailLines={TEXT_LINES} chevron={false} />
    </Group>
  );
}
