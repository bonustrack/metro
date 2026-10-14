import { describe, expect, test } from 'bun:test';
import { connectorHost, connectorLabel } from '../src/api/connectors.js';

const first = { id: 'instance001', name: 'Calendar', url: 'https://calendar.example/private-path?key=fixture-secret' };
const second = { ...first, id: 'instance002' };

describe('connector instance labels', () => {
  test('same-name and same-endpoint instances use full stable IDs, not endpoint details', () => {
    const peers = [first, second];
    expect(peers.map((row) => connectorLabel(row, peers))).toEqual(['Calendar (instance001)', 'Calendar (instance002)']);
    expect(connectorLabel(first, [...peers].reverse())).toBe(connectorLabel(first, peers));
    expect(connectorHost(first.url)).toBe('calendar.example');
    expect(JSON.stringify(peers.map((row) => connectorLabel(row, peers)))).not.toContain('fixture-secret');
  });

  test('unique names stay uncluttered in lists, confirmations always identify the instance', () => {
    expect(connectorLabel(first, [first])).toBe('Calendar');
    expect(connectorLabel(first, [first, { ...second, name: 'Tasks' }])).toBe('Calendar');
    expect(connectorLabel(first)).toBe('Calendar (instance001)');
    expect(connectorLabel({ ...first, name: 'Renamed' })).toBe('Renamed (instance001)');
  });

  test('the host keeps its port, and an invalid address never exposes a path or query', () => {
    expect(connectorHost('https://mcp.linear.app:8443/mcp')).toBe('mcp.linear.app:8443');
    expect(connectorHost('private-path?token=fixture-secret')).toBe('Address withheld');
    expect(connectorHost('')).toBe('Address withheld');
  });

  test('case and whitespace do not hide ambiguity, repeated snapshots of one ID do not create it', () => {
    expect(connectorLabel(first, [first, { ...second, name: ' calendar ' }])).toBe('Calendar (instance001)');
    expect(connectorLabel(first, [first, first])).toBe('Calendar');
  });
});
