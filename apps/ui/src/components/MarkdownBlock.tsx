import { type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { opensElsewhere } from './link';

interface MarkdownBlockProps {
  text: string;
  resolveLink?: (href: string) => string | null;
  onNavigate?: (hash: string) => void;
}

export function MarkdownBlock({ text, resolveLink, onNavigate }: MarkdownBlockProps): ReactNode {
  return (
    <div className="markdown markdown-compact">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            const inApp = href === undefined ? null : (resolveLink?.(href) ?? null);
            if (inApp === null)
              return (
                <a href={href} target="_blank" rel="noreferrer">
                  {children}
                </a>
              );
            return (
              <a
                href={inApp}
                onClick={(e) => {
                  if (opensElsewhere(e)) return;
                  e.preventDefault();
                  onNavigate?.(inApp);
                }}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
