import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { FormField } from './FormField.js';

interface Props {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}

export function PublicOAuthResource({ value, disabled, onChange }: Props): ReactNode {
  const dark = useKitScheme() === 'dark';
  return <Col gap={8}>
    <FormField label="Public OAuth resource (optional)" name="public-oauth-resource" value={value} placeholder="https://service.example.com/mcp/team" disabled={disabled} dark={dark} onChangeText={onChange} />
    <Text size="md" role="secondary">Leave blank unless the provider needs one. Type it yourself, never paste a connector URL: the browser shows it at sign-in, so no secrets, private paths or query strings.</Text>
  </Col>;
}
