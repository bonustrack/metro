import { type ReactNode, useEffect, useState } from 'react';
import { Platform, StyleSheet, type NativeSyntheticEvent, type TextInputKeyPressEventData } from 'react-native';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { SEARCH_INPUT_PROPS, TextField } from '@stage-labs/kit/react-native/text-field';
import { List } from '@stage-labs/kit/react-native/list';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { restartDaemon } from '@metro-labs/client/api/control';
import { updateAgentIn } from '@metro-labs/client/api/update';
import { activeAccount } from '@metro-labs/client/auth/account';
import { baseFromSegment } from '@metro-labs/client/auth/daemon';
import { routeHash } from '@metro-labs/client/route';
import type { Selection } from '@metro-labs/client/selection';
import { Icon } from '../Icon.js';
import { Modal } from '../Modal.js';
import { JumpList, Kbd } from './JumpList.js';
import { useJumpEntries, type JumpAction, type JumpItem } from './jump-entries.js';
import { isJumpKey, moveCursor, rankJump } from '../../lib/jump.js';
import { closeJump, toggleJump, useJumpOpen } from '../../lib/jump-store.js';
import { useIsNarrow } from '../../lib/media.js';
import { openExternal } from '../../lib/open.js';
import { queryError } from '../../lib/queries.js';
import { go } from '../../lib/nav.js';
import { GROW } from '../../lib/style.js';
import { ICON_SIZE } from '../ui/sizes.js';

const RESULTS_MAX = 420;

const styles = StyleSheet.create({
  field: { flexGrow: 1, minWidth: 0, borderWidth: 0, backgroundColor: 'transparent' },
  results: { maxHeight: RESULTS_MAX },
});

async function runAction(action: JumpAction): Promise<Selection | null> {
  if (action.kind === 'go') return action.target;
  const home: Selection = { kind: 'home', project: action.server.id };
  if (action.kind === 'terminal') {
    const target: Selection = { kind: 'terminal', project: action.server.id };
    if (Platform.OS !== 'web') return target;
    openExternal(`${window.location.pathname}${routeHash(target)}`);
    return null;
  }
  if (action.kind === 'restart') {
    await restartDaemon(baseFromSegment(action.server.host));
    return home;
  }
  const organization = activeAccount()?.organization ?? null;
  if (organization === null) throw new Error('Choose an organization first.');
  await updateAgentIn(organization, action.server.host);
  return home;
}

function useShortcut(): void {
  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (!isJumpKey(event.key, event.metaKey, event.ctrlKey)) return;
      event.preventDefault();
      toggleJump();
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, []);
}

function usePicker(): { running: string | null; error: string | null; pick: (item: JumpItem | undefined) => void } {
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pick = (item: JumpItem | undefined): void => {
    if (item === undefined || running !== null) return;
    setRunning(item.key);
    setError(null);
    runAction(item.payload.action)
      .then((target) => {
        closeJump();
        if (target !== null) go(target);
      })
      .catch((err: unknown) => { setError(queryError(err, 'That did not work.')); })
      .finally(() => { setRunning(null); });
  };
  return { running, error, pick };
}

interface FieldProps {
  query: string;
  sheet: boolean;
  onQuery: (query: string) => void;
  onMove: (by: number) => void;
  onEnter: () => void;
}

function SearchField({ query, sheet, onQuery, onMove, onEnter }: FieldProps): ReactNode {
  const palette = useKitPalette();
  const onKeyPress = (event: NativeSyntheticEvent<TextInputKeyPressEventData>): void => {
    const key = event.nativeEvent.key;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      onMove(key === 'ArrowDown' ? 1 : -1);
    } else if (key === 'Escape') closeJump();
  };
  return (
    <Row align="center" gap={12} padding={{ x: 16, y: 6 }} radius={12} background={palette.bg} margin={{ bottom: 8 }}>
      <Icon name="search" size={ICON_SIZE.md} color={palette.text} />
      <TextField name="jump" value={query} placeholder="Jump to an agent, a page or an action" autoFocus size="lg" onChangeText={onQuery} onSubmit={onEnter} style={styles.field}
        inputProps={{ ...SEARCH_INPUT_PROPS, onKeyPress, autoCapitalize: 'none', autoCorrect: false, returnKeyType: 'go' }} />
      {sheet ? null : <Kbd label="esc" />}
    </Row>
  );
}

function Hints(): ReactNode {
  const palette = useKitPalette();
  return (
    <Row align="center" gap={18} padding={{ x: 20, y: 12 }} border={{ top: { width: 1, color: palette.border } }}>
      <Row align="center" gap={6}><Kbd label="↑" /><Kbd label="↓" /><Text size="xs" color="secondary">Move</Text></Row>
      <Row align="center" gap={6}><Kbd label="↵" /><Text size="xs" color="secondary">Open</Text></Row>
      <Column style={GROW} />
      <Row align="center" gap={6}><Kbd label="J" /><Kbd label="K" /><Text size="xs" color="secondary">in lists</Text></Row>
    </Row>
  );
}

function JumpPanel(): ReactNode {
  const sheet = useIsNarrow();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const entries = useJumpEntries();
  const items = rankJump(entries, query);
  const { running, error, pick } = usePicker();
  const change = (next: string): void => {
    setQuery(next);
    setCursor(0);
  };
  return (
    <Modal open onClose={closeJump} side={sheet ? 'bottom' : 'center'} title="Jump to" footer={sheet ? undefined : <Hints />}>
      <SearchField query={query} sheet={sheet} onQuery={change} onMove={(by) => { setCursor((at) => moveCursor(at, by, items.length)); }} onEnter={() => { pick(items[cursor]); }} />
      {error === null ? null : <Column padding={{ bottom: 8 }}><Text size="md" color="danger">{error}</Text></Column>}
      <List style={styles.results} keyboardShouldPersistTaps="handled">
        <JumpList items={items} cursor={cursor} running={running} hints={!sheet} onCursor={setCursor} onPick={pick} />
      </List>
    </Modal>
  );
}

export function Jump(): ReactNode {
  const open = useJumpOpen();
  useShortcut();
  return open ? <JumpPanel /> : null;
}
