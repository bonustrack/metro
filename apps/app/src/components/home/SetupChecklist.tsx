import { type ReactNode } from 'react';
import { StyleSheet, Text as RNText, View } from 'react-native';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { fontName } from '@stage-labs/kit/tokens';
import { findAccount, type AccountGroup } from '@metro-labs/client/api/accounts';
import { fetchRecentSenders } from '@metro-labs/client/api/attach';
import { Icon } from '../Icon.js';
import { Group } from '../ui/Group.js';
import { joinNames } from '../../lib/approval-note.js';
import { useBoxQuery } from '../../lib/queries.js';
import type { Setup, SetupStep, StepId } from '../../lib/setup-steps.js';
import { go } from '../../lib/nav.js';
import { AVATAR_SIZE, ICON_SIZE } from '../ui/sizes.js';

const MARK = 28;
const CHECK = ICON_SIZE.md;
const FACE = AVATAR_SIZE.row;
const FACES_MAX = 3;
const FACE_OVERLAP = 10;
const FACE_RING = 2;
const FACE_LETTER = 0.4;

const ACTION: Record<StepId, string> = {
  model: 'Choose a model',
  chat: 'Connect a channel',
  write: 'Choose people',
  approve: 'Choose who approves',
  hello: 'Open the chats',
};

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14, minHeight: 60, borderBottomWidth: 1 },
  open: { alignItems: 'flex-start', paddingTop: 18, paddingBottom: 22 },
  mark: { width: MARK, height: MARK, borderRadius: MARK / 2, alignItems: 'center', justifyContent: 'center' },
});

function StepMark({ step, index, open }: { step: SetupStep; index: number; open: boolean }): ReactNode {
  const palette = useKitPalette();
  if (step.done)
    return (
      <View style={styles.mark}>
        <Icon name="check" size={CHECK} color={palette.success} />
      </View>
    );
  const frame = StyleSheet.flatten([styles.mark, open ? { backgroundColor: palette.link } : { borderWidth: 1.5, borderColor: palette.border }]);
  return (
    <View style={frame}>
      <Text size="xs" fontWeight="semibold" color={open ? palette.bg : palette.sub}>
        {String(index + 1)}
      </Text>
    </View>
  );
}

function useWrote(step: SetupStep, agentId: string, groups: AccountGroup[]): string[] {
  const accountId = step.id === 'write' && step.target.kind === 'station' ? step.target.accountId : '';
  const station = accountId === '' ? '' : findAccount(groups, accountId)?.station ?? '';
  const recent = useBoxQuery(['sender-cards', agentId, station, accountId, 'recent'], () => fetchRecentSenders(agentId, station, accountId), {
    enabled: station !== '' && agentId !== '',
    staleTime: 60_000,
    retry: false,
  });
  return (recent.data ?? []).map((sender) => (sender.name === '' ? sender.id : sender.name));
}

const faceStyles = StyleSheet.create({
  stack: { flexDirection: 'row', alignItems: 'center' },
  ring: { borderRadius: FACE, borderWidth: FACE_RING },
  face: { width: FACE, height: FACE, borderRadius: FACE / 2, alignItems: 'center', justifyContent: 'center' },
  letter: { fontSize: FACE * FACE_LETTER, fontFamily: fontName.head },
});

function Faces({ letters }: { letters: string[] }): ReactNode {
  const palette = useKitPalette();
  const face = StyleSheet.flatten([faceStyles.face, { backgroundColor: palette.border }]);
  const letter = StyleSheet.flatten([faceStyles.letter, { color: palette.link }]);
  return (
    <View style={faceStyles.stack}>
      {letters.map((value, index) => (
        <View key={`${String(index)}:${value}`} style={StyleSheet.flatten([faceStyles.ring, { marginLeft: index === 0 ? 0 : -FACE_OVERLAP, borderColor: palette.bg }])}>
          <View style={face}>
            <RNText style={letter}>{value}</RNText>
          </View>
        </View>
      ))}
    </View>
  );
}

function Wrote({ names }: { names: string[] }): ReactNode {
  if (names.length === 0) return null;
  const letters = names.slice(0, FACES_MAX).map((name) => (name.trim()[0] ?? '?').toUpperCase());
  return (
    <Row gap={10} align="center" margin={{ top: 4 }}>
      <Faces letters={letters} />
      <Text size="xs" color="secondary" numberOfLines={1}>
        {`${joinNames(names.slice(0, FACES_MAX))} wrote already`}
      </Text>
    </Row>
  );
}

function OpenStep({ step, index, agentId, groups }: { step: SetupStep; index: number; agentId: string; groups: AccountGroup[] }): ReactNode {
  const palette = useKitPalette();
  const wrote = useWrote(step, agentId, groups);
  const frame = StyleSheet.flatten([styles.row, styles.open, { borderBottomColor: palette.border }]);
  return (
    <View style={frame}>
      <StepMark step={step} index={index} open />
      <Column weight={1} minWidth={0} gap={8}>
        <Text size="md">{step.title}</Text>
        <Text size="md" color={palette.text}>
          {step.hint}
        </Text>
        <Wrote names={wrote} />
        <Row margin={{ top: 8 }}>
          <Button size="md" color="primary" label={ACTION[step.id]} onPress={() => { go(step.target); }} />
        </Row>
      </Column>
    </View>
  );
}

function StepRow({ step, index }: { step: SetupStep; index: number }): ReactNode {
  const palette = useKitPalette();
  const frame = StyleSheet.flatten([styles.row, { borderBottomColor: palette.border }]);
  return (
    <View style={frame} accessibilityLabel={`${step.title}${step.done ? ', done' : ''}`}>
      <StepMark step={step} index={index} open={false} />
      <Column weight={1} minWidth={0} gap={2}>
        <Text size="md" color={palette.text}>
          {step.title}
        </Text>
        <Text size="xs" color="secondary" numberOfLines={2}>
          {step.hint}
        </Text>
      </Column>
    </View>
  );
}

export function SetupChecklist({ setup, agentId, groups }: { setup: Setup; agentId: string; groups: AccountGroup[] }): ReactNode {
  if (setup.open === null) return null;
  return (
    <Group label="Finish setting up" wide>
      {setup.steps.map((step, index) =>
        step === setup.open ? (
          <OpenStep key={step.id} step={step} index={index} agentId={agentId} groups={groups} />
        ) : (
          <StepRow key={step.id} step={step} index={index} />
        ),
      )}
    </Group>
  );
}
