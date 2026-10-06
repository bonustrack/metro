import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalId } from '@metro-labs/core/ids';
import { approvalsThrough } from '../src/approvals.ts';
import { channelEvent, channelText } from '../src/channel-text.ts';
import { Inbox } from '../src/inbox.ts';
import type { PermissionAsk } from '../src/link.ts';
import { SessionStore, projectFolder } from '../src/session-store.ts';
import { SessionWatch } from '../src/session-watch.ts';
import { runnerConfig } from '../src/config.ts';
import { allowedOnly, compactDue, Runner, runnerEnv, runnerOptions, type OpenSession } from '../src/runner.ts';
import type { MetroTools } from '../src/tool-proxy.ts';

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

describe('a chat message reaches the front as the same <channel> block Claude Code shows', () => {
  test('meta becomes attributes, keys that are not identifiers are dropped, quotes are escaped', () => {
    expect(channelText('metro', 'hi there', { line: 'metro://xmtp/a/b', from_name: 'Less "L"', 'bad-key': 'x', n: 3, nested: { a: 1 } })).toBe(
      '<channel source="metro" line="metro://xmtp/a/b" from_name="Less &quot;L&quot;" n="3">\nhi there\n</channel>',
    );
    expect(channelEvent({ content: 'x', meta: { line: 'l' } })).toEqual({ content: 'x', meta: { line: 'l' } });
    expect(channelEvent({ meta: {} })).toBeNull();
  });
});

describe('the inbox', () => {
  test('pushes user messages with a uuid and channel origin, never interrupt priority', async () => {
    const inbox = new Inbox();
    const a = inbox.push('chat', 'first');
    const b = inbox.push('call', 'second', 'now');
    const seen: unknown[] = [];
    for await (const m of inbox) {
      seen.push(m);
      if (seen.length === 2) inbox.close();
    }
    expect(seen).toEqual([
      expect.objectContaining({ uuid: a, origin: { kind: 'channel', server: 'metro' }, message: { role: 'user', content: 'first' } }),
      expect.objectContaining({ uuid: b }),
    ]);
    expect(seen.some((item) => typeof item === 'object' && item !== null && 'priority' in item)).toBe(false);
    expect(inbox.kindOf(a)).toBe('chat');
    expect(inbox.kindOf(b)).toBe('call');
  });

  test('keeps chat messages until a turn finishes them, so unfinished work survives', () => {
    const kept: number[] = [];
    const inbox = new Inbox((left) => kept.push(left.length));
    const a = inbox.push('chat', 'one');
    inbox.push('chat', 'two');
    inbox.push('call', 'words');
    expect(inbox.unanswered().map((u) => u.text)).toEqual(['one', 'two']);
    inbox.started([a]);
    expect(inbox.unanswered().map((u) => u.state)).toEqual(['started', 'queued']);
    inbox.finished([a]);
    expect(inbox.unanswered().map((u) => u.text)).toEqual(['two']);
    expect(kept).toEqual([1, 2, 2, 1]);
    const later = new Inbox();
    later.again([{ text: 'two', at: 5 }]);
    expect(later.unanswered(10)).toEqual([expect.objectContaining({ text: 'two', at: 5, state: 'queued' })]);
  });
});

describe('the session watch', () => {
  const toolUse = (id: string, name: string): Record<string, unknown> => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name }], usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5 } } });
  const toolResult = (id: string): Record<string, unknown> => ({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id }] } });

  test('holds a priority push while the front runs a metro write, never for reads or worker calls', async () => {
    const watch = new SessionWatch((tool) => tool === 'read');
    watch.observe(toolUse('t1', 'mcp__metro__read'));
    watch.observe({ ...toolUse('t2', 'mcp__metro__send'), parent_tool_use_id: 'toolu_worker' });
    expect(watch.writing).toBe(false);
    watch.observe(toolUse('t3', 'mcp__metro__send'));
    expect(watch.writing).toBe(true);
    expect(watch.context).toBe(1015);
    let released = false;
    const waiting = watch.whenNotWriting().then(() => {
      released = true;
    });
    await Bun.sleep(20);
    expect(released).toBe(false);
    watch.observe(toolResult('t3'));
    await waiting;
    expect(released).toBe(true);
  });

  test('waits for evidence that writes and compaction ended, never an elapsed cap', async () => {
    const watch = new SessionWatch(() => false);
    watch.observe(toolUse('t1', 'mcp__metro__send'));
    let written = false;
    const writing = watch.whenNotWriting().then(() => { written = true; });
    await Bun.sleep(50);
    expect(written).toBe(false);
    watch.observe(toolResult('t1'));
    await writing;
    watch.observe({ type: 'system', subtype: 'status', status: 'compacting' });
    expect(watch.compacting).toBe(true);
    let after = false;
    const held = watch.whenNotCompacting().then(() => {
      after = true;
    });
    await Bun.sleep(20);
    expect(after).toBe(false);
    watch.observe({ type: 'system', subtype: 'compact_boundary' });
    await held;
    expect(after).toBe(true);
    expect(watch.compacting).toBe(false);
    expect(watch.context).toBe(0);
    watch.observe({ type: 'result' });
    expect(watch.writing).toBe(false);
  });
});

describe('approvals', () => {
  test('ids match the daemon chat reply rule, and every ask goes to metro with its input', async () => {
    for (let i = 0; i < 200; i += 1) expect(PERMISSION_REPLY_RE.test(`yes ${approvalId()}`)).toBe(true);
    const asks: PermissionAsk[] = [];
    let answer: 'allow' | 'deny' = 'allow';
    const canUse = approvalsThrough({
      ask: (ask) => {
        asks.push(ask);
        return Promise.resolve(answer);
      },
    });
    const options = { signal: new AbortController().signal, toolUseID: 'u1', requestId: 'r1', agentID: 'w1', title: 'Claude wants to run ls' };
    expect(await canUse('Bash', { command: 'ls' }, options)).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
    answer = 'deny';
    expect(await canUse('mcp__metro__send', { line: 'l', text: 't' }, options)).toEqual({ behavior: 'deny', message: 'The owner did not approve this.' });
    expect(asks[0]).toEqual(expect.objectContaining({ tool_name: 'Bash', description: 'Claude wants to run ls', input_preview: '{"command":"ls"}' }));
  });
});

describe('the session store', () => {
  test('resumes only a session whose transcript is still there, and keeps unanswered chat', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdk-runner-store-'));
    const claude = join(dir, 'claude');
    const cwd = '/home/agent';
    const store = new SessionStore(join(dir, 'agent-session.json'), claude, cwd);
    const id = '3f4edfe1-a2ee-4543-9feb-5a956e26bdc2';
    expect(store.resumable()).toBeNull();
    store.save(id);
    expect(store.resumable()).toBeNull();
    mkdirSync(join(claude, 'projects', projectFolder(cwd)), { recursive: true });
    writeFileSync(join(claude, 'projects', '-home-agent', `${id}.jsonl`), '');
    expect(store.resumable()).toBe(id);
    store.saveUnanswered([{ text: 'hello', at: 1 }]);
    store.save('not-a-session');
    expect(store.unanswered()).toEqual([{ text: 'hello', at: 1 }]);
    expect(store.resumable()).toBe(id);
  });

  test('never overwrites malformed or unreadable saved input on restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdk-runner-corrupt-'));
    const path = join(dir, 'agent-session.json');
    const store = new SessionStore(path, join(dir, 'claude'), dir);
    try {
      for (const text of ['{PRIVATE', 'null', '[]', '{"sessionId":"bad"}', '{"unanswered":null}', '{"unanswered":"PRIVATE"}', '{"unanswered":[{"text":"PRIVATE"}]}', '{"context":-1}', '{"context":"PRIVATE"}', '{"context":null}']) {
        writeFileSync(path, text);
        expect(() => store.unanswered()).toThrow('saved Agent SDK state');
        expect(() => store.saveUnanswered([])).toThrow('saved Agent SDK state');
        expect(() => store.save('3f4edfe1-a2ee-4543-9feb-5a956e26bdc2')).toThrow('saved Agent SDK state');
        expect(readFileSync(path, 'utf8')).toBe(text);
      }
      rmSync(path);
      mkdirSync(path);
      expect(() => store.unanswered()).toThrow('saved Agent SDK state');
      expect(() => store.saveUnanswered([])).toThrow('saved Agent SDK state');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the runner compacts between calls', () => {
  test('only when idle with no call, past the limit, and not again until the context grew by half the limit', () => {
    const limit = 120_000;
    expect(compactDue({ context: 130_000, floor: 40_000, limit, busy: false })).toBe(true);
    expect(compactDue({ context: 130_000, floor: 40_000, limit, busy: true })).toBe(false);
    expect(compactDue({ context: 100_000, floor: 40_000, limit, busy: false })).toBe(false);
    expect(compactDue({ context: 130_000, floor: 100_000, limit, busy: false })).toBe(false);
    expect(compactDue({ context: 160_000, floor: 100_000, limit, busy: false })).toBe(true);
    expect(compactDue({ context: 130_000, floor: null, limit, busy: false })).toBe(true);
  });
});

describe('the runner starts the Claude Code that comes with the pinned SDK', () => {
  const tools: MetroTools = { config: { type: 'sdk', name: 'metro', instance: null as never }, readOnly: () => false, changed: () => undefined };
  const base = { METRO_RUNNER_MCP_URL: 'http://127.0.0.1:8420/mcp', METRO_AGENT_KEY: 'mk_x', HOME: '/home/agent', PATH: '/usr/bin' };
  const allow = (): Promise<{ behavior: 'deny'; message: string }> => Promise.resolve({ behavior: 'deny', message: 'no' });

  test('without METRO_RUNNER_CLAUDE the SDK picks its own bundled binary, never the box claude on PATH, and that binary never updates itself', () => {
    const cfg = runnerConfig(base, '/tmp');
    expect(cfg.claude).toBeNull();
    const options = runnerOptions(cfg, tools, allow, null, {});
    expect('pathToClaudeCodeExecutable' in options).toBe(false);
    expect(options.env).toMatchObject({ DISABLE_AUTOUPDATER: '1' });
  });

  test('metro agent names the store copy of that binary', () => {
    const cfg = runnerConfig({ ...base, METRO_RUNNER_CLAUDE: '/home/agent/.metro/sdk-runner/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude' }, '/tmp');
    expect(runnerOptions(cfg, tools, allow, 'resume-id', {}).pathToClaudeCodeExecutable).toBe(cfg.claude ?? '');
  });

  test('registers send as terminal without replacing existing terminal tool names', () => {
    expect(runnerEnv({}).CLAUDE_CODE_TERMINAL_MCP_TOOLS).toBe('mcp__metro__send');
    const env = { CLAUDE_CODE_TERMINAL_MCP_TOOLS: ' mcp__other__deliver, ,mcp__metro__send,mcp__other__deliver ', PATH: '/usr/bin' };
    expect(runnerEnv(env)).toMatchObject({ CLAUDE_CODE_TERMINAL_MCP_TOOLS: 'mcp__other__deliver,mcp__metro__send', PATH: '/usr/bin' });
    expect(env.CLAUDE_CODE_TERMINAL_MCP_TOOLS).toBe(' mcp__other__deliver, ,mcp__metro__send,mcp__other__deliver ');
    expect(runnerEnv({ CLAUDE_CODE_TERMINAL_MCP_TOOLS: ' , ' }).CLAUDE_CODE_TERMINAL_MCP_TOOLS).toBe('mcp__metro__send');
  });
});

describe('the session thinks with the one model the Model page picked', () => {
  const tools: MetroTools = { config: { type: 'sdk', name: 'metro', instance: null as never }, readOnly: () => false, changed: () => undefined };
  const base = { METRO_RUNNER_MCP_URL: 'http://127.0.0.1:8420/mcp', METRO_AGENT_KEY: 'mk_x', HOME: '/home/agent', PATH: '/usr/bin' };
  const allow = (): Promise<{ behavior: 'deny'; message: string }> => Promise.resolve({ behavior: 'deny', message: 'no' });

  test('front and workers use that model: no model of its own, no pin left in the environment', () => {
    const picked = runnerConfig({ ...base, METRO_RUNNER_MODEL: 'openrouter:anthropic/claude-sonnet-5.5' }, '/tmp');
    const options = runnerOptions(picked, tools, allow, null, { PATH: '/usr/bin', ANTHROPIC_MODEL: 'openrouter:old/model', CLAUDE_CODE_SUBAGENT_MODEL: 'claude-opus-5-5' });
    expect(options.model).toBe('openrouter:anthropic/claude-sonnet-5.5');
    expect(options.env).toEqual(expect.objectContaining({ PATH: '/usr/bin', DISABLE_AUTOUPDATER: '1' }));
    expect(Object.keys(options.env ?? {})).not.toContain('ANTHROPIC_MODEL');
    expect(Object.keys(options.env ?? {})).not.toContain('CLAUDE_CODE_SUBAGENT_MODEL');
    expect('settings' in options).toBe(false);
    const unpicked = runnerConfig(base, '/tmp');
    expect(unpicked.model).toBeNull();
    expect('model' in runnerOptions(unpicked, tools, allow, null, {})).toBe(false);
  });

  test('only that model is allowed, and no model means Claude Code default with no list', () => {
    expect(allowedOnly('claude-opus-5-5')).toEqual({ availableModels: ['claude-opus-5-5'], enforceAvailableModels: true });
    expect(allowedOnly(null)).toEqual({ availableModels: null, enforceAvailableModels: null });
  });

  test('a new model goes into the running session: the allowlist moves first, then the model, in order, with no restart', async () => {
    const steps: string[] = [];
    const fake = {
      applyFlagSettings: (settings: Record<string, unknown>) => {
        steps.push(`allow ${JSON.stringify(settings.availableModels)}`);
        return Promise.resolve();
      },
      setModel: async (model?: string) => {
        await Bun.sleep(5);
        steps.push(`model ${model ?? 'default'}`);
        if (model === 'refused') throw new Error('restricted');
      },
      close: () => undefined,
    };
    let opened = 0;
    const open: OpenSession = () => {
      opened += 1;
      return fake as never;
    };
    const dir = mkdtempSync(join(tmpdir(), 'sdk-runner-model-'));
    const runner = new Runner({ store: new SessionStore(join(dir, 's.json'), join(dir, 'claude'), dir), readOnly: () => false, open });
    const cfg = runnerConfig({ ...base, METRO_RUNNER_MODEL: 'claude-sonnet-5-5' }, dir);
    runner.start(runnerOptions(cfg, tools, allow, null, {}));
    await runner.switchModel('claude-sonnet-5-5');
    expect(steps).toEqual(['allow ["claude-sonnet-5-5"]', 'allow ["claude-sonnet-5-5"]']);
    steps.length = 0;
    const first = runner.switchModel('openrouter:a/b');
    const second = runner.switchModel('claude-opus-5-5');
    await Promise.all([first, second]);
    expect(steps).toEqual(['allow ["openrouter:a/b"]', 'model openrouter:a/b', 'allow ["claude-opus-5-5"]', 'model claude-opus-5-5']);
    steps.length = 0;
    await runner.switchModel('refused');
    await runner.switchModel(null);
    expect(steps).toEqual(['allow ["refused"]', 'model refused', 'allow null', 'model default']);
    expect(opened).toBe(1);
    runner.close();
  });
});
