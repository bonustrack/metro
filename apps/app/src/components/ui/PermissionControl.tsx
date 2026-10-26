import { type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette, type KitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Icon, type IconName } from '../Icon.js';
import { hideRailTip, topTip } from '../shell/RailTip.js';
import { useHover } from './hover.js';
import { ICON_SIZE } from './sizes.js';
import { MIXED_WORD, choiceStates, type ChoiceState, type PermissionChoice, type PermissionValue } from '../../lib/permission-words.js';
import { fillColor } from '../../lib/theme.js';

type ControlSize = 'sm' | 'md';

const CELL: Record<ControlSize, number> = { sm: 28, md: 32 };
const GLYPH: Record<ControlSize, number> = { sm: ICON_SIZE.sm, md: ICON_SIZE.md };
const PAD = 3;
const OFF = 0.28;
const DIM = 0.4;

const ICONS: Record<PermissionChoice, IconName> = { allow: 'checkCircle', ask: 'question', block: 'ban' };

const styles = StyleSheet.create({
  track: { flexDirection: 'row', alignItems: 'center', gap: 2, padding: PAD, borderRadius: 999, borderWidth: 1 },
  cell: { alignItems: 'center', justifyContent: 'center' },
});

function tint(choice: PermissionChoice, palette: KitPalette): { color: string; fill: string } {
  if (choice === 'allow') return { color: palette.success, fill: fillColor(palette.success) };
  if (choice === 'block') return { color: palette.danger, fill: fillColor(palette.danger) };
  return { color: palette.link, fill: fillColor(palette.link) };
}

interface CellProps {
  state: ChoiceState;
  size: ControlSize;
  onChange: ((choice: PermissionChoice) => void) | undefined;
}

function Cell({ state, size, onChange }: CellProps): ReactNode {
  const palette = useKitPalette();
  const [hovered, hover] = useHover();
  const lit = tint(state.choice, palette);
  const side = CELL[size];
  const frame = StyleSheet.flatten([styles.cell, { width: side, height: side, borderRadius: side / 2 }, state.selected ? { backgroundColor: lit.fill } : null, state.disabled && !state.selected ? { opacity: OFF } : null]);
  const color = state.selected ? lit.color : hovered && !state.disabled ? palette.link : palette.sub;
  const tip = topTip(state.word);
  const enter = (event: { currentTarget: unknown }): void => {
    hover.onHoverIn();
    tip.onHoverIn(event);
  };
  const leave = (): void => {
    hover.onHoverOut();
    hideRailTip();
  };
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={state.word}
      accessibilityState={{ checked: state.selected, disabled: state.disabled }}
      disabled={state.disabled || onChange === undefined}
      onPress={() => { onChange?.(state.choice); }}
      onHoverIn={enter}
      onHoverOut={leave}
      onFocus={enter}
      onBlur={leave}
      style={frame}
    >
      <Icon name={ICONS[state.choice]} size={GLYPH[size]} color={color} />
    </Pressable>
  );
}

interface PermissionControlProps {
  label: string;
  value: PermissionValue;
  onChange?: (choice: PermissionChoice) => void;
  disabled?: boolean;
  atLeast?: PermissionChoice | null;
  size?: ControlSize;
}

export function PermissionControl({ label, value, onChange, disabled = false, atLeast = null, size = 'md' }: PermissionControlProps): ReactNode {
  const palette = useKitPalette();
  const states = choiceStates(value, { disabled, atLeast });
  const track = StyleSheet.flatten([styles.track, { borderColor: palette.border }, disabled ? { opacity: DIM } : null]);
  return (
    <Row align="center" gap={12}>
      {value === 'mixed' ? (
        <Text size="xs" color={palette.text}>
          {MIXED_WORD}
        </Text>
      ) : null}
      <View accessibilityRole="radiogroup" accessibilityLabel={label} style={track}>
        {states.map((state) => (
          <Cell key={state.choice} state={state} size={size} onChange={onChange} />
        ))}
      </View>
    </Row>
  );
}
