import { type ReactNode } from 'react';
import { Platform } from 'react-native';
import { routeHash } from '@metro-labs/client/route';
import { TextLink } from './TextLink.js';

const KINDS = [
  { kind: 'terms-of-use', label: 'Terms' },
  { kind: 'privacy-policy', label: 'Privacy' },
] as const;

const elsewhere = (hash: string): string => (Platform.OS === 'web' ? `${window.location.origin}/${hash}` : `https://metro.box/${hash}`);

export function LegalLinks({ newTab = false }: { newTab?: boolean }): ReactNode {
  return KINDS.map(({ kind, label }) => {
    const hash = routeHash({ kind });
    return newTab ? (
      <TextLink key={kind} url={elsewhere(hash)}>
        {label}
      </TextLink>
    ) : (
      <TextLink key={kind} to={hash}>
        {label}
      </TextLink>
    );
  });
}
