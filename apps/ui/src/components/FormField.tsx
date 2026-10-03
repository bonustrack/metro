import { type ReactNode } from 'react';
import { Input, type InputProps } from '@stage-labs/kit/react-native/input';
import { Text } from '@stage-labs/kit/react-native/text';
import { FONT_SIZE, fontName } from '@stage-labs/kit/tokens';

const FIELD_INPUT = {
  backgroundColor: 'transparent',
  borderWidth: 0,
  borderRadius: 0,
  paddingHorizontal: 0,
  paddingVertical: 0,
  minHeight: 24,
  minWidth: 0,
  fontFamily: fontName.sans,
  fontSize: FONT_SIZE.md,
} as const;

interface FormFieldProps extends InputProps {
  label: string;
  labelHidden?: boolean;
}

export function FormField({ label, labelHidden = false, style, ...props }: FormFieldProps): ReactNode {
  return (
    <label className="form-field">
      <span className={labelHidden ? 'sr-only' : undefined}>
        <Text nativeID={props.name === undefined ? undefined : `label-${props.name}`} size="xs" role="secondary">
          {label}
        </Text>
      </span>
      <Input {...props} style={[FIELD_INPUT, style]} />
    </label>
  );
}
