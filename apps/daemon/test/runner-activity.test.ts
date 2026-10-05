import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAgentActivity } from '../src/claude/runner-activity.ts';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

test('activity reads are bounded, optional and do not return arbitrary snapshot fields', () => {
  const home = mkdtempSync(join(tmpdir(), 'metro-runner-status-'));
  homes.push(home);
  mkdirSync(join(home, '.metro'));
  const path = join(home, '.metro', 'agent-status.json');
  expect(readAgentActivity(home)).toBeNull();
  writeFileSync(path, '{bad');
  expect(readAgentActivity(home)).toBeNull();
  writeFileSync(path, JSON.stringify({ runner: 'sdk', pid: 123, updatedAt: 1000, phase: 'starting', key: 'not-for-api' }));
  expect(readAgentActivity(home)).toMatchObject({ runner: 'sdk', phase: 'starting', pid: 123 });
  expect(readAgentActivity(home)).not.toHaveProperty('key');
  const valid = JSON.stringify({ runner: 'sdk', pid: 123, updatedAt: 1000, phase: 'idle' });
  writeFileSync(path, valid.padEnd(65_536));
  expect(readAgentActivity(home)).not.toBeNull();
  writeFileSync(path, valid.padEnd(65_537));
  expect(readAgentActivity(home)).toBeNull();
  writeFileSync(path, JSON.stringify({ runner: 'sdk', pid: 123, updatedAt: 1000, phase: 'idle', padding: 'x'.repeat(70000) }));
  expect(readAgentActivity(home)).toBeNull();
});
