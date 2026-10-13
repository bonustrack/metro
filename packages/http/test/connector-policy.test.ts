import { describe, expect, test } from 'bun:test';
import { combineConnectorPolicies, connectorPoliciesBlocked, connectorPolicyOf, effectiveConnectorPolicy, type ConnectorPolicy } from '../src/connector-delivery.js';

type Access = 'allow' | 'ask' | 'deny';
const RULES: Access[] = ['allow', 'ask', 'deny'];
const rules = [undefined, ...RULES];
const rank = (value: Access): number => RULES.indexOf(value);
const policy = (read: Access | undefined, write: Access | undefined, tool: Access | undefined): ConnectorPolicy => ({ ...(read === undefined ? {} : { read }), ...(write === undefined ? {} : { write }), ...(tool === undefined ? {} : { tools: { same: tool } }) });
const access = (value: ConnectorPolicy, group: 'read' | 'write'): Access => value.tools?.same ?? value[group] ?? 'allow';

describe('organization and agent policy layers', () => {
  test('all group and named combinations enforce each layer, then take the stricter rule', () => {
    for (const read of rules) for (const write of rules) for (const tool of rules) {
      const organization = policy(read, write, tool);
      for (const agentRead of rules) for (const agentWrite of rules) for (const agentTool of rules) {
        const agent = policy(agentRead, agentWrite, agentTool);
        const legacy = combineConnectorPolicies(organization, agent);
        for (const group of ['read', 'write'] as const) {
          const row = { policy: legacy, policyLayers: { organization, agent } };
          const effective = effectiveConnectorPolicy(row, { same: group });
          const expected = Math.max(rank(access(organization, group)), rank(access(agent, group)));
          expect(rank(access(effective, group))).toBe(expected);
          expect(rank(access(legacy, group))).toBeGreaterThanOrEqual(expected);
        }
        expect(access(effectiveConnectorPolicy({ policy: legacy, policyLayers: { organization, agent } }, {}), 'write'))
          .toBe(access(effectiveConnectorPolicy({ policy: legacy, policyLayers: { organization, agent } }, { same: 'write' }), 'write'));
      }
    }
  });

  test('a missing catalogue defaults to write without overriding named organization restrictions', () => {
    const row = { policy: {}, policyLayers: { organization: { read: 'allow', write: 'ask', tools: { remove: 'deny' } }, agent: { tools: { remove: 'allow', unseen: 'allow' } } } } as const;
    expect(effectiveConnectorPolicy(row, {})).toMatchObject({ tools: { remove: 'deny', unseen: 'ask' } });
    expect(effectiveConnectorPolicy({ policy: { write: 'deny' } }, {})).toEqual({ write: 'deny' });
  });

  test('named exceptions are not mistaken for a fully blocked connector before discovery', () => {
    const layers = { organization: { read: 'deny', write: 'deny', tools: { same: 'allow' } }, agent: { read: 'deny' } } as const;
    expect(connectorPoliciesBlocked(layers)).toBe(false);
    expect(connectorPoliciesBlocked({ ...layers, agent: { tools: { same: 'deny' } } })).toBe(true);
    expect(connectorPoliciesBlocked({ organization: { read: 'deny' }, agent: { write: 'deny' } })).toBe(true);
  });

  test('disjoint maximum policy maps remain deliverable without losing modern named rules', () => {
    const organization: ConnectorPolicy = { tools: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`org_${i}`, 'ask'])) };
    const agent: ConnectorPolicy = { tools: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`agent_${i}`, 'deny'])) };
    const legacy = combineConnectorPolicies(organization, agent);
    expect(connectorPolicyOf(legacy)).toEqual({ read: 'deny', write: 'deny' });
    const effective = effectiveConnectorPolicy({ policy: legacy, policyLayers: { organization, agent } }, {});
    expect(Object.keys(effective.tools ?? {})).toHaveLength(4000);
    expect(effective.tools?.org_0).toBe('ask');
    expect(effective.tools?.agent_1999).toBe('deny');
  });

  test('prototype-named tools use only own rules and otherwise inherit their real group', () => {
    for (const name of ['toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf']) {
      for (const floor of ['ask', 'deny'] as const) {
        const organization: ConnectorPolicy = { write: floor, tools: { other: 'allow' } };
        const agent: ConnectorPolicy = { tools: { [name]: 'allow' } };
        const row = { policy: {}, policyLayers: { organization, agent } };
        for (const groups of [{}, { [name]: 'write' as const }, Object.setPrototypeOf({}, { [name]: 'read' })]) {
          expect(effectiveConnectorPolicy(row, groups).tools?.[name]).toBe(floor);
        }
        expect(effectiveConnectorPolicy(row, { [name]: 'read' }).tools?.[name]).toBe('allow');
        expect(combineConnectorPolicies(organization, agent).tools?.[name]).toBe(floor);
      }
      expect(connectorPoliciesBlocked({ organization: { read: 'deny', write: 'deny', tools: { other: 'deny' } }, agent: { tools: { [name]: 'allow' } } })).toBe(true);
    }
  });

  test('invalid fields and prototype keys are refused rather than weakening permissions', () => {
    for (const value of [null, { write: 'block' }, { delete: 'ask' }, { tools: { constructor: 'allow' } }, JSON.parse('{"tools":{"__proto__":"deny"}}') as unknown]) {
      expect(() => connectorPolicyOf(value)).toThrow();
    }
  });
});
