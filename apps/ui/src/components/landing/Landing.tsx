import { type ReactNode } from 'react';
import { Icon, type HeroIconName } from '@stage-labs/kit/react-native/icon';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button, Text } from '../ui.js';
import { MetroLogo } from '../MetroLogo.js';
import { ConnectorFavicon } from '../ConnectorFavicon.js';
import { THEME_MODES, useThemeMode, type ThemeMode } from '../../theme-mode.js';
import { FONT_SANS } from '../../theme.js';
import { HERO, LOGIN_HASH, NAV, TRUST, WAITLIST_HASH, scrollToSection } from './content.js';
import { Manifesto } from './Manifesto.js';
import { HeroDemo } from './HeroDemo.js';
import { Control, Parts, Privacy } from './Sections.js';
import { useScrolled } from './reveal.js';
import './landing.css';
import './demo.css';

const NAV_OFFSET = 8;
const CTA_BOX = { height: 53 } as const;
const CTA_TEXT = { fontFamily: FONT_SANS, fontSize: 19, lineHeight: 29 } as const;
const LOGO_SIZE = 24;
const COPYRIGHT = `© ${String(new Date().getFullYear())} Metro`;

function go(hash: string): void {
  window.location.hash = hash;
}

function Wordmark(): ReactNode {
  const palette = useKitPalette();
  return (
    <a
      className="lp-wordmark"
      href="#/"
      aria-label="Metro"
      onClick={(event) => {
        event.preventDefault();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }}
    >
      <MetroLogo size={LOGO_SIZE} color={palette.link} />
    </a>
  );
}

function Nav(): ReactNode {
  const scrolled = useScrolled(NAV_OFFSET);
  return (
    <header className={`lp-nav${scrolled ? ' is-scrolled' : ''}`}>
      <div className="lp-bar">
        <Wordmark />
        <nav className="lp-bar-links" aria-label="Sections">
          {NAV.map((item) => (
            <button key={item.id} type="button" className="lp-bar-cell" onClick={() => { scrollToSection(item.id); }}>
              {item.label}
            </button>
          ))}
        </nav>
        <button type="button" className="lp-bar-login" onClick={() => { go(LOGIN_HASH); }}>
          Log in
        </button>
      </div>
    </header>
  );
}

function Trust(): ReactNode {
  const palette = useKitPalette();
  return (
    <div className="lp-trust">
      <Text size="xl" role="secondary">
        Works where your team already talks
      </Text>
      <div className="lp-trust-row">
        {TRUST.map((item) => (
          <span key={item.name} className="lp-trust-item">
            <ConnectorFavicon name={item.name} url={item.url} size={28} />
            <Text size="xl" weight="medium" color={palette.link}>
              {item.name}
            </Text>
          </span>
        ))}
      </div>
    </div>
  );
}

function Hero(): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <section className="lp-hero">
      <div className="lp-hero-copy">
        <div className="lp-hero-main">
          <h1 className="lp-h1">
            {HERO.title.map((line) => (
              <span key={line} className="lp-line">
                {line}
              </span>
            ))}
          </h1>
        </div>
        <div className="lp-hero-side">
          <p className="lp-lead">{HERO.body}</p>
          <div className="lp-actions">
            <Button size="xl" color="primary" dark={dark} label="Join the waitlist" style={CTA_BOX} textStyle={CTA_TEXT} onPress={() => { go(WAITLIST_HASH); }} />
          </div>
        </div>
      </div>
      <HeroDemo />
      <Trust />
    </section>
  );
}

function TextLink({ label, onPress }: { label: string; onPress: () => void }): ReactNode {
  const palette = useKitPalette();
  return (
    <button type="button" className="lp-textlink" onClick={onPress}>
      <span>{label}</span>
      <Icon name="chevronRight" size={16} color={palette.link} />
    </button>
  );
}

function Closing(): ReactNode {
  return (
    <section className="lp-closing">
      <div className="lp-closing-card">
        <h2 className="lp-h2 lp-closing-title">The next chapter of your company runs on your own agent.</h2>
        <div className="lp-closing-links">
          <TextLink
            label="Join the waitlist"
            onPress={() => {
              go(WAITLIST_HASH);
            }}
          />
          <TextLink
            label="Log in"
            onPress={() => {
              go(LOGIN_HASH);
            }}
          />
        </div>
      </div>
    </section>
  );
}

const THEME_ICON: Record<ThemeMode, HeroIconName> = { system: 'desktop', light: 'sun', dark: 'moon' };

function ThemeSwitch(): ReactNode {
  const { mode, setMode } = useThemeMode();
  const palette = useKitPalette();
  return (
    <span className="lp-theme" role="radiogroup" aria-label="Theme">
      {THEME_MODES.map((m) => (
        <button
          key={m.mode}
          type="button"
          role="radio"
          aria-checked={m.mode === mode}
          aria-label={m.label}
          title={m.label}
          className={`lp-theme-opt${m.mode === mode ? ' is-on' : ''}`}
          onClick={() => {
            setMode(m.mode);
          }}
        >
          <Icon name={THEME_ICON[m.mode]} size={16} color={m.mode === mode ? palette.link : palette.sub} />
        </button>
      ))}
    </span>
  );
}

function Footer(): ReactNode {
  return (
    <footer className="lp-footer">
      <div className="lp-footer-inner">
        <div className="lp-footer-brand">
          <Wordmark />
          <Text size="sm" role="secondary">
            {COPYRIGHT}
          </Text>
        </div>
        <div className="lp-footer-links">
          <Text size="sm" role="secondary">
            Terms
          </Text>
          <Text size="sm" role="secondary">
            Privacy
          </Text>
          <ThemeSwitch />
        </div>
      </div>
    </footer>
  );
}

export function Landing(): ReactNode {
  return (
    <div className="lp">
      <Nav />
      <main>
        <Hero />
        <Manifesto />
        <Parts />
        <Privacy />
        <Control />
      </main>
      <Closing />
      <Footer />
    </div>
  );
}
