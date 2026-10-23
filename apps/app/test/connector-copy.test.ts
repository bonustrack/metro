import { expect, test } from 'bun:test';
import type { OrganizationRow } from '@metro-labs/client/api/auth';
import { toOrgConnector } from '@metro-labs/client/api/org-connectors';
import { copiedConnectorHash, copyOrganizationName, copyTarget, copyTargets } from '../src/lib/connector-copy.js';

const source: OrganizationRow = { id: 'org_SOURCE00000000', name: 'Source', slug: 'source', role: 'admin', avatar: null, agents: null };
const destination: OrganizationRow = { ...source, id: 'org_DESTINATION0000', name: 'Destination', slug: 'destination' };

test('only another organization where the person is an admin is a copy destination', () => {
  const member = { ...destination, id: 'org_MEMBER00000000', role: 'member' };
  const unknown = { ...destination, id: 'org_UNKNOWN0000000', role: null };
  expect(copyTargets([source, member, destination, unknown], source.id)).toEqual([destination]);
  expect(copyTargets([source, member], source.id)).toEqual([]);
  expect(copyTargets([destination], null)).toEqual([]);
});

test('only the stored destination is selected, never an implicit replacement', () => {
  expect(copyTarget([destination], '')).toBeUndefined();
  expect(copyTarget([destination, source], '')).toBeUndefined();
  expect(copyTarget([destination, source], destination.id)).toEqual(destination);
  expect(copyTarget([destination], 'org_REVOKED0000000')).toBeUndefined();
});

test('the explicit destination action uses its organization route and the copied instance, not the source', () => {
  const result = { organization: destination.id, connector: toOrgConnector({ id: 'copied00001', name: 'Copy' }) };
  expect(copiedConnectorHash(result, destination)).toBe('#/destination/organization/connectors/copied00001/settings');
  expect(copiedConnectorHash(result, { ...destination, slug: null })).toBe('#/org_DESTINATION0000/organization/connectors/copied00001/settings');
  expect(copiedConnectorHash(result, { ...destination, slug: 'settings' })).toBe('#/org_DESTINATION0000/organization/connectors/copied00001/settings');
});

test('destination labels follow the organization switcher fallbacks', () => {
  expect(copyOrganizationName(destination)).toBe('Destination');
  expect(copyOrganizationName({ ...destination, name: null })).toBe('destination');
  expect(copyOrganizationName({ ...destination, name: null, slug: null })).toBe(destination.id);
});
