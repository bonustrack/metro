import { type ReactNode } from 'react';
import { TextField } from '@stage-labs/kit/react-native/text-field';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from '@stage-labs/kit/react-native/text';
import { FONT_SIZE } from '@stage-labs/kit/tokens';
import { FONT_SANS } from '../theme.js';

interface LabeledFieldProps {
  label: string;
  name: string;
  value: string;
  placeholder: string;
  inputMode: 'email' | 'numeric';
  autoFocus?: boolean;
  disabled: boolean;
  onChangeText: (text: string) => void;
  onSubmit: () => void;
}

export function LabeledField(props: LabeledFieldProps): ReactNode {
  const palette = useKitPalette();
  return (
    <label className="labeled-field">
      <Text size="xs" role="secondary">
        {props.label}
      </Text>
      <TextField
        name={props.name}
        value={props.value}
        placeholder={props.placeholder}
        inputMode={props.inputMode}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus={props.autoFocus}
        disabled={props.disabled}
        variant="plain"
        background="transparent"
        paddingX={0}
        paddingY={0}
        minHeight={0}
        radius={0}
        fontSize={FONT_SIZE.md}
        fontFamily={FONT_SANS}
        color={palette.link}
        placeholderColor={palette.sub}
        onChangeText={props.onChangeText}
        onSubmit={props.onSubmit}
      />
    </label>
  );
}
