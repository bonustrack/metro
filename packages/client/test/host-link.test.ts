import { describe, expect, test } from 'bun:test';
import { hostHash, hostTarget } from '../src/auth/host-link.js';
import type { OrganizationRow } from '../src/api/auth.js';

const HOST = 'metro-vutmn2.tail17c4f8.ts.net';
const STAGE = 'org_01STAGE0000000000';
const MCI = 'org_01MCI000000000000';

const agent = (id: string, host: string, slug: string | null): NonNullable<OrganizationRow['agents']>[number] => ({ id, host, name: null, slug, avatar: null });

const org = (id: string, slug: string, agents: OrganizationRow['agents']): OrganizationRow => ({ id, name: slug, role: 'admin', slug, agents });

const stage = org(STAGE, 'stage', [agent('emmaAgentId', HOST, 'emma')]);
const mci = org(MCI, 'mci-group', [agent('lisaAgentId', 'metro-fa79qt.tail17c4f8.ts.net', 'lisa')]);

describe('a link to a raw box address', () => {
  test('opens the agent in the organization that owns the box, not the one selected', () => {
    expect(hostTarget([mci, stage], HOST, STAGE, MCI)).toEqual({ kind: 'listed', organization: 'stage', agent: 'emma' });
  });

  test('ignores a copy filed under another organization when the owner lists the box', () => {
    const filed = org(MCI, 'mci-group', [agent('copyAgentId', HOST, 'metro-vutmn2-tail17c4f8-ts-net')]);
    expect(hostTarget([filed, stage], HOST, STAGE, MCI)).toEqual({ kind: 'listed', organization: 'stage', agent: 'emma' });
  });

  test('adds the box to the owner organization when that organization does not list it yet', () => {
    expect(hostTarget([mci, org(STAGE, 'stage', [])], HOST, STAGE, MCI)).toEqual({ kind: 'add', organization: STAGE });
  });

  test('refuses a box owned by an organization this account is not in', () => {
    expect(hostTarget([mci], HOST, STAGE, MCI)).toEqual({ kind: 'foreign' });
  });

  test('without an owner, prefers the selected organization, then any that lists the box', () => {
    const filed = org(MCI, 'mci-group', [agent('copyAgentId', HOST, 'copy')]);
    expect(hostTarget([stage, filed], HOST, null, MCI)).toEqual({ kind: 'listed', organization: 'mci-group', agent: 'copy' });
    expect(hostTarget([mci, stage], HOST.toUpperCase(), null, MCI)).toEqual({ kind: 'listed', organization: 'stage', agent: 'emma' });
  });

  test('without an owner or a listing, adds the box to the selected organization', () => {
    expect(hostTarget([mci, org(STAGE, 'stage', null)], HOST, null, MCI)).toEqual({ kind: 'add', organization: MCI });
  });

  test('an organization or agent without a slug is named by its id', () => {
    const plain = org(STAGE, 'stage', [agent('emmaAgentId', HOST, null)]);
    expect(hostTarget([{ ...plain, slug: null }], HOST, STAGE, MCI)).toEqual({ kind: 'listed', organization: STAGE, agent: 'emmaAgentId' });
  });
});

describe('the address the raw box link becomes', () => {
  test('swaps the host for the new segment and keeps the page', () => {
    expect(hostHash(`#/${HOST}/server`, 'stage/emma')).toBe('#/stage/emma/server');
    expect(hostHash(`#/${HOST}`, 'stage/emma')).toBe('#/stage/emma');
    expect(hostHash(`#/${HOST}:8420/sessions/a/b`, 'emma')).toBe('#/emma/sessions/a/b');
  });

  test('drops an organization that was in front of the host', () => {
    expect(hostHash(`#/mci-group/${HOST}/server`, 'stage/emma')).toBe('#/stage/emma/server');
    expect(hostHash(`#/${MCI}/${HOST}/channels`, 'emma')).toBe('#/emma/channels');
  });
});
