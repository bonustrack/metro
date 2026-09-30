import { type ReactNode } from 'react';
import { Text } from '@stage-labs/kit/react-native/text';
import { routeHash } from '../route.js';

export function LegalLinks({ newTab = false }: { newTab?: boolean }): ReactNode {
  return (
    <>
      <Text size="md" role="secondary">
        <a className="hint-link" href={routeHash({ kind: 'terms-of-use' })} target={newTab ? '_blank' : undefined} rel={newTab ? 'noopener noreferrer' : undefined}>Terms</a>
      </Text>
      <Text size="md" role="secondary">
        <a className="hint-link" href={routeHash({ kind: 'privacy-policy' })} target={newTab ? '_blank' : undefined} rel={newTab ? 'noopener noreferrer' : undefined}>Privacy</a>
      </Text>
    </>
  );
}
