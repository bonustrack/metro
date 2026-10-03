import { describe, expect, test } from 'bun:test';
import { instanceLabel, toServerLink } from '../src/api/aws.js';

describe('what the page shows about the AWS account of a server', () => {
  test('a link answer reads as one of three states, with safe defaults', () => {
    expect(toServerLink({ mode: 'metro', region: 'us-east-1', instanceId: 'i-0abc' })).toEqual({ mode: 'metro' });
    expect(toServerLink({ mode: 'none', connections: 2 })).toEqual({ mode: 'none', connections: 2 });
    expect(toServerLink({ mode: 'none' })).toEqual({ mode: 'none', connections: 0 });
    expect(toServerLink({ mode: 'linked', connection: 'c1', accountId: '111122223333', region: 'eu-central-2', instanceId: 'i-0abc' })).toEqual({
      mode: 'linked',
      connection: 'c1',
      accountId: '111122223333',
      region: 'eu-central-2',
      instanceId: 'i-0abc',
    });
    expect(() => toServerLink(null)).toThrow('unexpected response');
  });

  test('an instance is named by its Name tag when it has one, with its id, region and state', () => {
    const base = { connection: 'c1', accountId: '111122223333', region: 'eu-central-2', instanceId: 'i-0abc', state: 'running', type: 't4g.medium', node: null, agentId: null };
    expect(instanceLabel({ ...base, name: 'Andy' })).toBe('Andy · i-0abc · eu-central-2 · running');
    expect(instanceLabel({ ...base, name: null })).toBe('i-0abc · eu-central-2 · running');
  });
});
