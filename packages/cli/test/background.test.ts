import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_VIEW_OFF,
  heldConversation,
  keepInSession,
  liveBackground,
  processAlive,
  projectDir,
  takeBackConversation,
} from '../src/background.ts';

const MAIN = 'a96909bf-12d8-4061-b92d-703676659bcf';
const MOVED = '329ccd96-85ee-49c8-94ff-60bf6390e145';
const OTHER = '95cb7df0-e93f-43b4-9982-e777842130af';

let home = '';
let claude = '';
let project = '';
let sessions = '';

const turn = (sessionId: string): string => JSON.stringify({ type: 'user', sessionId, message: { role: 'user', content: 'hi' } });
const handoff = (sessionId: string, to: string): string =>
  JSON.stringify({ type: 'continued-in', timestamp: '2026-09-26T17:36:41.000Z', sessionId, continuedInSessionId: to });

function transcript(id: string, lines: string[], at: number): void {
  const path = join(project, `${id}.jsonl`);
  writeFileSync(path, `${lines.join('\n')}\n`);
  utimesSync(path, at, at);
}

function register(pid: number, sessionId: string, kind: string): void {
  writeFileSync(join(sessions, `${String(pid)}.json`), JSON.stringify({ pid, sessionId, cwd: '/home/agent', kind, status: 'idle', procStart: '1' }));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'metro-background-'));
  claude = join(home, '.claude');
  project = projectDir(claude, '/home/agent');
  sessions = join(claude, 'sessions');
  mkdirSync(project, { recursive: true });
  mkdirSync(sessions, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('the Metro session stays in the foreground', () => {
  test('Claude Code background sessions are switched off unless the user chose otherwise', () => {
    expect(keepInSession({ HOME: '/h' })).toEqual({ HOME: '/h', [AGENT_VIEW_OFF]: '1' });
    expect(keepInSession({ [AGENT_VIEW_OFF]: '0' })).toEqual({ [AGENT_VIEW_OFF]: '0' });
  });

  test('the project folder is named the way Claude Code names it', () => {
    expect(projectDir('/h/.claude', '/home/agent')).toBe('/h/.claude/projects/-home-agent');
  });
});

describe('which Claude Code sessions run in the background', () => {
  test('a live background session counts; an interactive one, a dead one and a broken file do not', () => {
    register(101, MOVED, 'bg');
    register(102, MAIN, 'interactive');
    register(103, OTHER, 'bg');
    writeFileSync(join(sessions, '104.json'), '{not json');
    expect(liveBackground(sessions, (pid) => pid !== 103)).toEqual(new Set([MOVED]));
  });

  test('no sessions folder means none', () => {
    expect(liveBackground(join(home, 'missing'))).toEqual(new Set());
  });

  test('this process is alive and a pid that cannot exist is not', () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(2 ** 22 + 7)).toBe(false);
  });
});

describe('a conversation a background session holds', () => {
  test('is the one that moved away when claude -c would reach it first (Andy, 2026-09-26)', () => {
    transcript(MAIN, [turn(MAIN), handoff(MAIN, MOVED)], 1_000);
    transcript(MOVED, [turn(MOVED)], 2_000);
    expect(heldConversation(project, new Set([MOVED]))).toBe(MOVED);
  });

  test('is none once the background session has stopped', () => {
    transcript(MAIN, [turn(MAIN), handoff(MAIN, MOVED)], 1_000);
    transcript(MOVED, [turn(MOVED)], 2_000);
    expect(heldConversation(project, new Set())).toBeNull();
    expect(heldConversation(project, new Set([OTHER]))).toBeNull();
  });

  test('is none when a newer conversation of its own comes first', () => {
    transcript(MAIN, [turn(MAIN), handoff(MAIN, MOVED)], 1_000);
    transcript(OTHER, [turn(OTHER)], 3_000);
    expect(heldConversation(project, new Set([MOVED]))).toBeNull();
  });

  test('a newer file with no turn in it is passed over, as Claude Code does', () => {
    transcript(MAIN, [turn(MAIN), handoff(MAIN, MOVED)], 1_000);
    transcript(OTHER, [JSON.stringify({ type: 'mode', mode: 'default' })], 3_000);
    expect(heldConversation(project, new Set([MOVED]))).toBe(MOVED);
  });
});

describe('metro claude takes a held conversation back', () => {
  const env = (): NodeJS.ProcessEnv => ({ HOME: home });

  test('stops the background session by its short id, then says so', async () => {
    transcript(MAIN, [turn(MAIN), handoff(MAIN, MOVED)], 1_000);
    transcript(MOVED, [turn(MOVED)], 2_000);
    register(101, MOVED, 'bg');
    let running = true;
    const stopped: string[] = [];
    const note = await takeBackConversation({
      env: env(),
      cwd: '/home/agent',
      alive: () => running,
      stop: (id) => {
        stopped.push(id);
        running = false;
        return { ok: true, detail: '' };
      },
    });
    expect(stopped).toEqual(['329ccd96']);
    expect(note).toContain('stopped that session');
  });

  test('a stop that fails is reported with what to run by hand', async () => {
    transcript(MAIN, [turn(MAIN), handoff(MAIN, MOVED)], 1_000);
    register(101, MOVED, 'bg');
    const note = await takeBackConversation({
      env: env(),
      cwd: '/home/agent',
      alive: () => true,
      stop: () => ({ ok: false, detail: 'no such session' }),
      settleMs: 0,
    });
    expect(note).toContain('no such session');
    expect(note).toContain('claude stop 329ccd96');
  });

  test('nothing held means nothing is stopped', async () => {
    transcript(MAIN, [turn(MAIN)], 1_000);
    register(101, OTHER, 'bg');
    const note = await takeBackConversation({
      env: env(),
      cwd: '/home/agent',
      alive: () => true,
      stop: () => {
        throw new Error('must not stop');
      },
    });
    expect(note).toBeNull();
  });
});
