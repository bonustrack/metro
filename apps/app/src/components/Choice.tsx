import { type ReactNode } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';

interface ChoiceProps<T extends string> {
  label: string;
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  disabled?: boolean;
  onChange: (value: T) => void;
}

const styles = StyleSheet.create({
  opt: { paddingVertical: 6, paddingHorizontal: 14, borderRadius: 999 },
  off: { opacity: 0.6 },
});

export function Choice<T extends string>({ label, value, options, disabled = false, onChange }: ChoiceProps<T>): ReactNode {
  const palette = useKitPalette();
  const on = { backgroundColor: palette.bg };
  return (
    <Row accessibilityRole="radiogroup" accessibilityLabel={label} gap={2} padding={3} radius={999} surface="raised" style={SELF}>
      {options.map((option) => {
        const selected = option.value === value;
        const off = disabled || option.disabled === true;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected, disabled: off }}
            disabled={off}
            style={[styles.opt, selected ? on : null, off ? styles.off : null]}
            onPress={() => {
              if (!selected) onChange(option.value);
            }}
          >
            <Text size="2xs" role={selected ? 'link' : 'secondary'} numberOfLines={1}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </Row>
  );
}

const SELF = { alignSelf: 'flex-start' } as const;
