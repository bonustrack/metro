import { type ReactNode } from 'react';
import { Text } from '@stage-labs/kit/react-native/text';
import { routeHash } from '../route.js';

export function LegalLinks(): ReactNode {
  return (
    <>
      <Text size="md" role="secondary">
        <a className="hint-link" href={routeHash({ kind: 'terms-of-use' })}>Terms</a>
      </Text>
      <Text size="md" role="secondary">
        <a className="hint-link" href={routeHash({ kind: 'privacy-policy' })}>Privacy</a>
      </Text>
    </>
  );
}
