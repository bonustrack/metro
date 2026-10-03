import { type ReactNode, useEffect } from 'react';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { LegalLinks } from '../LegalLinks.js';
import { MarkdownBlock } from '../MarkdownBlock.js';
import { MetroLogo } from '../MetroLogo.js';
import { useDocumentTitle } from '../../title.js';
import { LEGAL_PAGES } from './content.js';
import '../landing/landing.css';
import './legal.css';

type LegalKind = 'terms-of-use' | 'privacy-policy';

export function LegalPage({ kind }: { kind: LegalKind }): ReactNode {
  const palette = useKitPalette();
  const page = LEGAL_PAGES[kind];
  useDocumentTitle(page.title);
  useEffect(() => { window.scrollTo(0, 0); }, [kind]);
  return (
    <div className="app-root lp">
      <header className="lp-nav">
        <div className="lp-bar">
          <a className="lp-wordmark" href="#/" aria-label="Metro home">
            <MetroLogo size={24} color={palette.link} />
          </a>
          <a className="hint-link" href="#/login">Log in</a>
        </div>
      </header>
      <main className="legal-content">
        <article>
          <MarkdownBlock text={page.text} />
        </article>
      </main>
      <footer className="lp-footer">
        <div className="lp-footer-inner">
          <Text size="2xs" role="secondary">Stage Labs</Text>
          <nav className="lp-footer-links" aria-label="Legal">
            <LegalLinks />
          </nav>
        </div>
      </footer>
    </div>
  );
}
