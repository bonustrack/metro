import { type ReactNode } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { Text } from '@stage-labs/kit/react-native/text';
import { FormField } from './FormField.js';

interface Props {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}

export function PublicOAuthResource({ value, disabled, onChange }: Props): ReactNode {
  return <Column gap={8}>
    <FormField label="Public OAuth resource (optional)" name="public-oauth-resource" value={value} placeholder="https://service.example.com/mcp/team" disabled={disabled} onChangeText={onChange} />
    <Text size="md" color="secondary">Leave blank unless the provider needs one. Type it yourself, never paste a connector URL: the browser shows it at sign-in, so no secrets, private paths or query strings.</Text>
  </Column>;
}
