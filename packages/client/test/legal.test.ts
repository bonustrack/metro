import { afterEach, describe, expect, test } from 'bun:test';
import { routeHash, routeSelection } from '../src/route.js';
import { clearAccount, storeAccount } from '../src/auth/account.js';
import { forgetAgents, rememberAgents } from '../src/auth/agent-route.js';
import { noteRoutedOrganization, routedOrganization } from '../src/auth/org-route.js';
import { isOrganizationSlug, namedSegment } from '../src/auth/org-segment.js';
import { routedSegment } from '../src/auth/daemon.js';
import { installTestAccount } from './account-fixture.js';

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

});
