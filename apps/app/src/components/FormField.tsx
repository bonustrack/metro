import { type ReactNode, useRef } from 'react';
import { Pressable, StyleSheet, type TextInput } from 'react-native';
import { Input, type InputProps } from '@stage-labs/kit/react-native/input';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { FONT_SIZE, fontName } from '@stage-labs/kit/tokens';

const styles = StyleSheet.create({
  box: { flexGrow: 1, flexShrink: 1, minWidth: 0, gap: 2, paddingTop: 8, paddingHorizontal: 16, paddingBottom: 12, borderRadius: 4 },
  input: {
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderRadius: 0,
    paddingHorizontal: 0,
    paddingVertical: 0,
    minHeight: 24,
    minWidth: 0,
    fontFamily: fontName.sans,
    fontSize: FONT_SIZE.md,
  },
  hidden: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0 },
});

interface FormFieldProps extends InputProps {
  label: string;
  labelHidden?: boolean;
}

export function FormField({ label, labelHidden = false, style, ...props }: FormFieldProps): ReactNode {
  const palette = useKitPalette();
  const input = useRef<TextInput>(null);
  const box = [styles.box, { backgroundColor: palette.border }];
  return (
    <Pressable
      accessible={false}
      style={box}
      onPress={() => {
        input.current?.focus();
      }}
    >
      <Text nativeID={props.name === undefined ? undefined : `label-${props.name}`} size="xs" role="secondary" style={labelHidden ? styles.hidden : undefined}>
        {label}
      </Text>
      <Input ref={input} {...props} style={[styles.input, style]} />
    </Pressable>
  );
}
