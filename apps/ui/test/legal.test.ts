import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { routeHash, routeSelection } from '../src/route.js';
import { clearAccount, storeAccount } from '../src/auth/account.js';
import { forgetAgents, rememberAgents } from '../src/auth/agent-route.js';
import { noteRoutedOrganization, routedOrganization } from '../src/auth/org-route.js';
import { isOrganizationSlug, namedSegment } from '../src/auth/org-segment.js';
import { routedSegment } from '../src/auth/daemon.js';
import { installTestAccount } from './account-fixture.js';
import { LEGAL_PAGES } from '../src/components/legal/content.js';

const KINDS = ['terms-of-use', 'privacy-policy'] as const;

afterEach(() => {
  clearAccount();
  forgetAgents();
  noteRoutedOrganization(null);
});

describe('public legal pages', () => {
  test('anonymous routes are global pages, never an organization or box', () => {
    clearAccount();
    for (const kind of KINDS) {
      for (const hash of [`#/${kind}`, `#/${kind}/`]) {
        expect(routeSelection(hash)).toEqual({ kind });
        expect(routedOrganization()).toBeNull();
        expect(routedSegment(hash)).toBeNull();
      }
      expect(routeHash({ kind })).toBe(`#/${kind}`);
      expect(isOrganizationSlug(kind)).toBe(false);
    }
  });

  test('legal links stay public when an organization is signed in or routed', () => {
    installTestAccount();
    noteRoutedOrganization('example-org');
    for (const kind of KINDS) expect(routeHash({ kind })).toBe(`#/${kind}`);
  });

  test('existing organizations and agents with legal slugs remain reachable by ID', () => {
    for (const slug of KINDS) {
      const account = installTestAccount();
      storeAccount({ ...account, organizationSlug: slug });
      rememberAgents([{ id: 'aB3-_xYz9Qw', slug }]);
      expect(namedSegment('org_01OTHEROWNER000', slug)).toBe('org_01OTHEROWNER000');
      expect(routeHash({ kind: 'servers' })).toBe(`#/${account.organization}`);
      const selection = { kind: 'server', project: 'aB3-_xYz9Qw' } as const;
      const hash = routeHash(selection);
      expect(hash).toBe(`#/${account.organization}/aB3-_xYz9Qw/server`);
      expect(routeSelection(hash)).toEqual(selection);
      noteRoutedOrganization(null);
    }
  });

  test('login footer opens legal pages separately to preserve an active email-code form', () => {
    const login = readFileSync(new URL('../src/components/Login.tsx', import.meta.url), 'utf8');
    expect(login).toContain('<LegalLinks newTab />');
  });

  test('legal pages render before the account boot and do not depend on private APIs', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    const legal = app.indexOf('return <LegalPage');
    const metro = app.indexOf('return <MetroApp');
    expect(legal).toBeGreaterThan(-1);
    expect(metro).toBeGreaterThan(-1);
    expect(legal).toBeLessThan(metro);
    const page = readFileSync(new URL('../src/components/legal/LegalPage.tsx', import.meta.url), 'utf8');
    expect(page).not.toMatch(/from ['"][^'"]*(?:auth|api)\//);
  });

  test('copy identifies only Stage Labs as operator and contains no contact or private infrastructure identifiers', () => {
    for (const kind of KINDS) {
      const { title, text } = LEGAL_PAGES[kind];
      expect(text).toStartWith(`# ${title}\n`);
      expect(text).toContain('Metro is operated by Stage Labs.');
      expect(text).not.toMatch(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i);
      expect(text).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b|\b0x[\da-f]{40}\b|\b\d{10,}\b/i);
      expect(text).not.toMatch(/(?:\/home\/|\/var\/lib\/|\.ts\.net\b|localhost|mailto:)/i);
    }
  });

  test('privacy copy warns about configured AI providers instead of promising Limited Use compliance', () => {
    expect(LEGAL_PAGES['privacy-policy'].text).toContain('Limited Use');
    expect(LEGAL_PAGES['privacy-policy'].text).toContain('does not enforce');
  });
});
