import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedTranscripts, isoWeek, MEMORY_FOLDERS, memoryPaths, memoryRoutine, previousWeek, routineArgs, routinePrompt, settleWorkstreams, takeLock, type MemoryPaths } from '../src/memory.ts';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-memory-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const at = (iso: string): number => new Date(iso).getTime();

function touch(path: string, iso: string, text = '{}\n'): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  utimesSync(path, new Date(iso), new Date(iso));
}

const paths = (): MemoryPaths => ({
  claude: join(dir, 'claude'),
  memory: join(dir, 'claude', 'projects', '-home-agent', 'memory'),
  skill: join(dir, 'claude', 'skills', 'memory', 'SKILL.md'),
  state: join(dir, 'state.json'),
  lock: join(dir, 'routine.lock'),
});

describe('where the memory routine looks', () => {
  test("is Claude Code's auto-memory folder of the home folder, or the autoMemoryDirectory its settings name", () => {
    const home = join(dir, 'home');
    mkdirSync(join(home, '.claude'), { recursive: true });
    const found = memoryPaths({ HOME: home });
    expect(found.memory).toBe(join(home, '.claude', 'projects', home.replace(/[^A-Za-z0-9]/g, '-'), 'memory'));
    expect(found.skill).toBe(join(home, '.claude', 'skills', 'memory', 'SKILL.md'));
    expect(found.state).toBe(join(home, '.metro', 'memory-routine.json'));
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ autoMemoryDirectory: '~/notes' }));
    expect(memoryPaths({ HOME: home }).memory).toBe(join(home, 'notes'));
    expect(memoryPaths({ HOME: home, CLAUDE_CONFIG_DIR: join(dir, 'cfg') }).skill).toBe(join(dir, 'cfg', 'skills', 'memory', 'SKILL.md'));
  });

  test('reads only transcripts changed since the last run, newest first, and never the memory folder', () => {
    const projects = join(dir, 'projects');
    touch(join(projects, '-home-agent', 'a.jsonl'), '2026-10-01T10:00:00Z');
    touch(join(projects, '-home-agent', 'b', 'subagents', 'agent-1.jsonl'), '2026-10-01T12:00:00Z');
    touch(join(projects, '-home-agent', 'old.jsonl'), '2026-09-29T10:00:00Z');
    touch(join(projects, '-home-agent', 'notes.txt'), '2026-10-01T10:00:00Z');
    touch(join(projects, '-home-agent', 'memory', 'x.jsonl'), '2026-10-01T10:00:00Z');
    const found = changedTranscripts(projects, at('2026-09-30T00:00:00Z'));
    expect(found.map((f) => f.path)).toEqual([join(projects, '-home-agent', 'b', 'subagents', 'agent-1.jsonl'), join(projects, '-home-agent', 'a.jsonl')]);
    expect(changedTranscripts(join(dir, 'none'), 0)).toEqual([]);
  });

  test('names the ISO week the way timeline/weekly files are named', () => {
    expect(isoWeek(new Date('2026-09-28T00:00:00Z'))).toBe('2026-W40');
    expect(isoWeek(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53');
    expect(previousWeek(new Date('2026-10-01T00:17:00Z'))).toEqual({ id: '2026-W39', monday: '2026-09-21', sunday: '2026-09-27' });
    expect(previousWeek(new Date('2026-10-05T00:17:00Z'))).toEqual({ id: '2026-W40', monday: '2026-09-28', sunday: '2026-10-04' });
  });
});

describe('the run the routine starts', () => {
  test('points Claude Code at the skill, the memory folder and the changed transcripts', () => {
    const p = paths();
    const prompt = routinePrompt(new Date('2026-10-02T00:17:00Z'), new Date('2026-10-01T00:17:00Z'), p, [{ path: '/t/a.jsonl', size: 4096, mtime: 0 }]);
    expect(prompt).toContain(`Read the memory skill at ${p.skill}`);
    expect(prompt).toContain(`Memory folder: ${p.memory}`);
    expect(prompt).toContain('- /t/a.jsonl (4 KiB)');
    expect(prompt).toContain('yesterday was 2026-10-01');
    expect(prompt).toContain('timeline/weekly/2026-W39.md');
    expect(prompt).toContain('a Friday (UTC)');
  });

  test('has no metro tools, no shell, no network and writes only inside the memory folder', () => {
    const args = routineArgs('go', '/home/agent/.claude/projects/-home-agent/memory', 'Be kind.');
    expect(args.slice(0, 2)).toEqual(['-p', 'go']);
    expect(args).toContain('dontAsk');
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Write,Edit,Glob,Grep');
    expect(args).toContain('Edit(//home/agent/.claude/projects/-home-agent/memory/**)');
    expect(args.join(' ')).not.toContain('Bash');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--no-session-persistence');
    expect(args).not.toContain('--mcp-config');
    expect(args.join(' ')).not.toMatch(/WebFetch|WebSearch|Agent|curl/);
    expect(args.slice(-2)).toEqual(['--append-system-prompt', 'Be kind.']);
    expect(routineArgs('go', '/m', null)).not.toContain('--append-system-prompt');
  });

  test('runs one at a time, and a lock left by a dead run or older than two hours is taken over', () => {
    const lock = join(dir, 'x.lock');
    expect(takeLock(lock)).toBe(true);
    expect(takeLock(lock)).toBe(false);
    expect(takeLock(lock, Date.now() + 3 * 60 * 60_000)).toBe(true);
    writeFileSync(lock, '999999999');
    expect(takeLock(lock)).toBe(true);
  });

  test('moves the workstreams marked finished to completed and fixes their index lines, and leaves the rest', () => {
    const memory = join(dir, 'memory');
    const note = (status: string): string => `---\nname: x\nmetadata:\n  status: ${status}\n---\n# X\n`;
    touch(join(memory, 'workstreams', 'active', 'done.md'), '2026-10-01T00:00:00Z', note('completed'));
    touch(join(memory, 'workstreams', 'active', 'parked.md'), '2026-10-01T00:00:00Z', note('"parked"'));
    touch(join(memory, 'workstreams', 'active', 'going.md'), '2026-10-01T00:00:00Z', note('active'));
    touch(join(memory, 'workstreams', 'active', 'clash.md'), '2026-10-01T00:00:00Z', note('completed'));
    touch(join(memory, 'workstreams', 'completed', 'clash.md'), '2026-10-01T00:00:00Z', note('completed'));
    touch(join(memory, 'MEMORY.md'), '2026-10-01T00:00:00Z', '- [Done](workstreams/active/done.md): x\n- [Going](workstreams/active/going.md): y\n');
    expect(settleWorkstreams(memory).sort()).toEqual(['done.md', 'parked.md']);
    expect(existsSync(join(memory, 'workstreams', 'completed', 'done.md'))).toBe(true);
    expect(existsSync(join(memory, 'workstreams', 'active', 'going.md'))).toBe(true);
    expect(existsSync(join(memory, 'workstreams', 'active', 'clash.md'))).toBe(true);
    expect(readFileSync(join(memory, 'MEMORY.md'), 'utf8')).toBe('- [Done](workstreams/completed/done.md): x\n- [Going](workstreams/active/going.md): y\n');
    expect(settleWorkstreams(join(dir, 'none'))).toEqual([]);
  });

  test('stops before Claude Code when there is no skill, or no activity, or another run holds the lock', async () => {
    const p = paths();
    expect(await memoryRoutine(p, new Date('2026-10-02T00:17:00Z'))).toBe(0);
    touch(p.skill, '2026-09-01T00:00:00Z', '---\nname: memory\n---\n');
    touch(join(p.claude, 'projects', '-home-agent', 'old.jsonl'), '2026-09-29T10:00:00Z');
    expect(await memoryRoutine(p, new Date('2026-10-02T00:17:00Z'))).toBe(0);
    expect(existsSync(p.memory)).toBe(false);
    expect(existsSync(p.lock)).toBe(false);
    writeFileSync(p.state, JSON.stringify({ lastRun: '2026-09-20T00:00:00Z' }));
    touch(join(p.claude, 'projects', '-home-agent', 'stale.jsonl'), '2026-09-28T10:00:00Z');
    expect(await memoryRoutine(p, new Date('2026-10-02T00:17:00Z'))).toBe(0);
    expect(existsSync(p.memory)).toBe(false);
    writeFileSync(p.lock, String(process.pid));
    expect(await memoryRoutine(p, new Date('2026-10-02T00:17:00Z'))).toBe(0);
    expect(existsSync(p.lock)).toBe(true);
    expect(MEMORY_FOLDERS).toHaveLength(10);
  });
});
