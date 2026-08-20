import { type ReactNode } from 'react';
import { Text } from './ui';
import { type HintLink } from '../api/attach';

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function LinkedText({
  text,
  links,
}: {
  text: string;
  links: HintLink[];
}): ReactNode {
  if (links.length === 0) return <Text size="sm" role="secondary">{text}</Text>;

  const pattern = new RegExp(`(${links.map((l) => escape(l.text)).join('|')})`, 'g');
  const parts = text.split(pattern);

  return (
    <Text size="sm" role="secondary">
      {parts.map((part, index) => {
        const link = links.find((l) => l.text === part);
        if (link === undefined) return part;
        return (
          <a
            key={`${link.href}-${String(index)}`}
            className="hint-link"
            href={link.href}
            target="_blank"
            rel="noreferrer"
          >
            {part}
          </a>
        );
      })}
    </Text>
  );
}
