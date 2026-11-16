import { beforeEach, describe, expect, test } from 'bun:test';
import { copyOrganizations } from '../src/connectors/copy.ts';
import { TEST_OWNER, TEST_STRANGER } from './identity-helper.ts';

let reads: string[];
let failing: boolean;

const directory = {
  userMemberships: (user: string) => {
    reads.push(user);
    if (failing) return Promise.reject(new Error('Provider-private-error-fixture'));
    return Promise.resolve([{ id: TEST_OWNER, role: 'admin' }, { id: TEST_STRANGER, role: 'admin' }]);
  },
};

beforeEach(() => {
  reads = [];
  failing = false;
});

describe('the production copy membership adapter', () => {
  test('one fresh membership read checks the verified user, every time', async () => {
    const user = 'user_fixture+special/@';
    expect(await copyOrganizations(directory, user)).toEqual([{ id: TEST_OWNER, role: 'admin' }, { id: TEST_STRANGER, role: 'admin' }]);
    expect(reads).toEqual([user]);
    await copyOrganizations(directory, user);
    expect(reads).toEqual([user, user]);
  });

  test('a failed read becomes a sanitized temporary-unavailability response', async () => {
    failing = true;
    await expect(copyOrganizations(directory, 'user_fixture')).rejects.toMatchObject({ status: 503, message: 'Metro could not verify organization admin memberships. Try again.' });
    expect(reads).toEqual(['user_fixture']);
  });
});
