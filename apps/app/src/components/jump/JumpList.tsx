import { Fragment, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { AgentAvatar } from '../AgentAvatar.js';
import { Icon } from '../Icon.js';
import { Spinner } from '../Spinner.js';
import { groupJump, JUMP_GROUP_LABEL } from '../../lib/jump.js';
import { allSides } from '../ui/edges.js';
import { hoverColor } from '../../lib/theme.js';
import { SHRINK } from '../../lib/style.js';
import type { JumpItem } from './jump-entries.js';
import { agentSeed } from '@metro-labs/client/api/servers';

const LEAD = 24;
const SEPARATOR = 14;

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 10, minHeight: 48 },
  lead: { width: LEAD, alignItems: 'center' },
});

export function Kbd({ label }: { label: string }): ReactNode {
  const palette = useKitPalette();
  return (
    <Row minWidth={26} height={26} padding={{ x: 6 }} radius={6} align="center" justify="center" border={allSides(palette.border)}>
      <Text size="xs" role="secondary">{label}</Text>
    </Row>
  );
}

function Lead({ item }: { item: JumpItem }): ReactNode {
  const palette = useKitPalette();
  const { server, icon } = item.payload;
  if (item.group === 'agents' && server !== null) return <AgentAvatar seed={agentSeed(server)} src={server.avatar} size={LEAD} />;
  return icon === null ? null : <Icon name={icon} size={20} color={palette.text} />;
}

function Crumbs({ crumbs }: { crumbs: string[] }): ReactNode {
  const palette = useKitPalette();
  return crumbs.map((crumb, at) => {
    const last = at === crumbs.length - 1;
    return (
      <Fragment key={`${String(at)}:${crumb}`}>
        <Text size="md" role={last ? 'default' : 'secondary'} color={last ? palette.link : undefined} numberOfLines={1} style={last ? SHRINK : undefined}>{crumb}</Text>
        {last ? null : <Icon name="chevronRight" size={SEPARATOR} color={palette.sub} />}
      </Fragment>
    );
  });
}

interface RowProps {
  item: JumpItem;
  active: boolean;
  busy: boolean;
  hints: boolean;
  onHover: () => void;
  onPick: () => void;
}

function JumpRow({ item, active, busy, hints, onHover, onPick }: RowProps): ReactNode {
  const palette = useKitPalette();
  const frame = StyleSheet.flatten([styles.row, active ? { backgroundColor: hoverColor(palette) } : null]);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={item.crumbs.join(', ')} accessibilityState={{ selected: active }} onHoverIn={onHover} onPress={onPick} style={frame}>
      <View style={styles.lead}><Lead item={item} /></View>
      <Row flex={1} minWidth={0} align="center" gap={8}>
        <Crumbs crumbs={item.crumbs} />
        {item.payload.sub === null ? null : <Text size="md" role="secondary" numberOfLines={1} style={SHRINK}>{item.payload.sub}</Text>}
      </Row>
      {busy ? <Spinner color={palette.link} /> : active && hints ? <Kbd label="↵" /> : null}
    </Pressable>
  );
}

interface ListProps {
  items: JumpItem[];
  cursor: number;
  running: string | null;
  hints: boolean;
  onCursor: (at: number) => void;
  onPick: (item: JumpItem) => void;
}

export function JumpList({ items, cursor, running, hints, onCursor, onPick }: ListProps): ReactNode {
  if (items.length === 0)
    return (
      <Col padding={{ x: 14, y: 24 }}>
        <Text size="md" role="secondary">Nothing matches. Try an agent name or a page.</Text>
      </Col>
    );
  return (
    <Col gap={16}>
      {groupJump(items).map(({ group, entries }) => (
        <Col key={group} gap={2}>
          <Col padding={{ x: 14, bottom: 6 }}>
            <Text size="xs" role="secondary">{JUMP_GROUP_LABEL[group]}</Text>
          </Col>
          {entries.map((item) => {
            const at = items.indexOf(item);
            return <JumpRow key={item.key} item={item} active={hints && at === cursor} busy={running === item.key} hints={hints} onHover={() => { onCursor(at); }} onPick={() => { onPick(item); }} />;
          })}
        </Col>
      ))}
    </Col>
  );
}
