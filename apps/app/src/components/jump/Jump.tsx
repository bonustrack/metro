import { type ReactNode, useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, type NativeSyntheticEvent, type TextInputKeyPressEventData } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Dialog } from '@stage-labs/kit/react-native/dialog';
import { Input, SEARCH_INPUT_PROPS } from '@stage-labs/kit/react-native/input';
import { MODAL } from '@stage-labs/kit/react-native/modal';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { restartDaemon } from '@metro-labs/client/api/control';
import { updateAgentIn } from '@metro-labs/client/api/update';
import { activeAccount } from '@metro-labs/client/auth/account';
import { baseFromSegment } from '@metro-labs/client/auth/daemon';
import { routeHash } from '@metro-labs/client/route';
import type { Selection } from '@metro-labs/client/selection';
import { Icon } from '../Icon.js';
import { JumpList, Kbd } from './JumpList.js';
import { useJumpEntries, type JumpAction, type JumpItem } from './jump-entries.js';
import { isJumpKey, moveCursor, rankJump } from '../../lib/jump.js';
import { closeJump, toggleJump, useJumpOpen } from '../../lib/jump-store.js';
import { useIsNarrow } from '../../lib/media.js';
import { openExternal } from '../../lib/open.js';
import { queryError } from '../../lib/queries.js';
import { go } from '../../lib/nav.js';
import { GROW } from '../../lib/style.js';

const PALETTE_WIDTH = 640;
const PALETTE_HEIGHT = '80%';
const SHEET_HEIGHT = '92%';
const RESULTS_PAD = { x: 8, top: 8, bottom: 8 };

const styles = StyleSheet.create({ field: { flexGrow: 1, minWidth: 0, borderWidth: 0, backgroundColor: 'transparent' } });

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
  const dark = useKitScheme() === 'dark';
  const onKeyPress = (event: NativeSyntheticEvent<TextInputKeyPressEventData>): void => {
    const key = event.nativeEvent.key;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      onMove(key === 'ArrowDown' ? 1 : -1);
    } else if (key === 'Escape') closeJump();
  };
  return (
    <Row align="center" gap={12} padding={sheet ? { x: 16, y: 6 } : { x: 20, y: 12 }} radius={sheet ? 12 : 0} background={sheet ? palette.bg : undefined}
      border={sheet ? undefined : { bottom: { width: 1, color: palette.border } }} margin={sheet ? { x: 12, bottom: 8 } : undefined}>
      <Icon name="search" size={22} color={palette.text} />
      <Input name="jump" value={query} placeholder="Jump to an agent, a page or an action" autoFocus dark={dark} size="lg" onChangeText={onQuery} onSubmit={onEnter} style={styles.field}
        inputProps={{ ...SEARCH_INPUT_PROPS, onKeyPress, autoCapitalize: 'none', autoCorrect: false, returnKeyType: 'go' }} />
      {sheet ? (
        <Pressable accessibilityRole="button" onPress={closeJump}>
          <Text size="md" role="secondary">Cancel</Text>
        </Pressable>
      ) : <Kbd label="esc" />}
    </Row>
  );
}

function Hints(): ReactNode {
  const palette = useKitPalette();
  return (
    <Row align="center" gap={18} padding={{ x: 20, y: 12 }} border={{ top: { width: 1, color: palette.border } }}>
      <Row align="center" gap={6}><Kbd label="↑" /><Kbd label="↓" /><Text size="xs" role="secondary">Move</Text></Row>
      <Row align="center" gap={6}><Kbd label="↵" /><Text size="xs" role="secondary">Open</Text></Row>
      <Col style={GROW} />
      <Row align="center" gap={6}><Kbd label="J" /><Kbd label="K" /><Text size="xs" role="secondary">in lists</Text></Row>
    </Row>
  );
}

function JumpPanel(): ReactNode {
  const palette = useKitPalette();
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
  const header = (
    <Col>
      <SearchField query={query} sheet={sheet} onQuery={change} onMove={(by) => { setCursor((at) => moveCursor(at, by, items.length)); }} onEnter={() => { pick(items[cursor]); }} />
      {error === null ? null : <Col padding={{ x: 20, top: 8 }}><Text size="md" role="danger">{error}</Text></Col>}
    </Col>
  );
  return (
    <Dialog open onClose={closeJump} side={sheet ? 'bottom' : 'center'} header={header} footer={sheet ? undefined : <Hints />} animationType="none" gestureRoot
      backdropColor={MODAL.backdrop} panelBackground={palette.inputBg} panelBorderColor={palette.border} panelBorderSides={sheet ? 'top' : 'all'} panelRadius={sheet ? 20 : 16}
      panelWidth="100%" panelMaxWidth={sheet ? undefined : PALETTE_WIDTH} panelMaxHeight={sheet ? SHEET_HEIGHT : PALETTE_HEIGHT} panelPadding={sheet ? { top: 10 } : undefined}
      handle={sheet} handleColor={palette.border} safeAreaBottom={sheet} scroll keyboardPersistTaps scrollPadding={RESULTS_PAD}>
      <JumpList items={items} cursor={cursor} running={running} hints={!sheet} onCursor={setCursor} onPick={pick} />
    </Dialog>
  );
}

export function Jump(): ReactNode {
  const open = useJumpOpen();
  useShortcut();
  return open ? <JumpPanel /> : null;
}
