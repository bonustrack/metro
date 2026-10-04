import { type ReactNode } from 'react';
import { FormField } from './FormField.js';

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
  return (
    <FormField
      label={props.label}
      name={props.name}
      value={props.value}
      placeholder={props.placeholder}
      autoFocus={props.autoFocus}
      disabled={props.disabled}
      inputType={props.inputMode === 'email' ? 'email' : 'number'}
      inputProps={{ autoCapitalize: 'none', autoCorrect: false, inputMode: props.inputMode, keyboardType: props.inputMode === 'email' ? 'email-address' : 'number-pad', autoComplete: props.inputMode === 'email' ? 'email' : 'one-time-code' }}
      onChangeText={props.onChangeText}
      onSubmit={props.onSubmit}
    />
  );
}
