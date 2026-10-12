import { useState, type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
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
  const [expanded, setExpanded] = useState(false);
  return <Col gap={8}>
    <Button color="secondary" dark={dark} label={expanded ? 'Hide public OAuth resource' : 'Advanced: public OAuth resource'} disabled={disabled} onPress={() => { setExpanded(!expanded); }} />
    {expanded ? <>
      <FormField label="Public OAuth resource (optional)" name="public-oauth-resource" value={value} placeholder="https://service.example.com/mcp/team" disabled={disabled} dark={dark} onChangeText={onChange} />
      <Text size="2xs" role="secondary">Discovery may ask for the provider's public OAuth resource. Leave this blank to try public origin metadata. Type the public identifier independently, never copy a saved connector URL. It is visible in the browser during sign-in: no credentials, private paths or query strings.</Text>
    </> : null}
  </Col>;
}
