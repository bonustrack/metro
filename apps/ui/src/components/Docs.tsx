import { type ReactNode } from 'react';
import Markdown from 'react-markdown';
import rehypeSlug from 'rehype-slug';
import remarkGfm from 'remark-gfm';
import { Col } from '@stage-labs/kit/react-native/box';
import { PageTitle } from './PageTitle';
import setupDoc from '../../../../docs/SETUP.md?raw';

function scrollTo(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const DOC_WIDTH = { maxWidth: 900, width: '100%' } as const;

export function Docs(): ReactNode {
  return (
    <Col gap={16} style={DOC_WIDTH}>
      <PageTitle>Documentation</PageTitle>
      <div className="markdown">
        <Markdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeSlug]}
          components={{
            a: ({ href, children }) =>
              href?.startsWith('#') === true ? (
                <a
                  href={href}
                  onClick={(event) => {
                    event.preventDefault();
                    scrollTo(href.slice(1));
                  }}
                >
                  {children}
                </a>
              ) : (
                <a href={href} target="_blank" rel="noreferrer">
                  {children}
                </a>
              ),
            table: ({ children }) => (
              <div className="markdown-table">
                <table>{children}</table>
              </div>
            ),
          }}
        >
          {setupDoc}
        </Markdown>
      </div>
    </Col>
  );
}
