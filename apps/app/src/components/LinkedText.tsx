import { type ReactNode } from 'react';
import { Text } from '@stage-labs/kit/react-native/text';
import { type HintLink } from '@metro-labs/client/api/attach';
import { openExternal } from '../lib/open.js';

const UNDERLINE = { textDecorationLine: 'underline' } as const;

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function LinkedText({ text, links }: { text: string; links: HintLink[] }): ReactNode {
  if (links.length === 0)
    return (
      <Text size="2xs" role="secondary">
        {text}
      </Text>
    );
  const pattern = new RegExp(`(${links.map((l) => escape(l.text)).join('|')})`, 'g');
  const parts = text.split(pattern);
  return (
    <Text size="2xs" role="secondary">
      {parts.map((part, index) => {
        const link = links.find((l) => l.text === part);
        if (link === undefined) return part;
        return (
          <Text
            key={`${link.href}-${String(index)}`}
            size="2xs"
            role="link"
            style={UNDERLINE}
            accessibilityRole="link"
            onPress={() => {
              openExternal(link.href);
            }}
          >
            {part}
          </Text>
        );
      })}
    </Text>
  );
}
