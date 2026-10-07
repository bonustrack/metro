import { query, type CanUseTool, type Options, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { errMsg, log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import type { AutomationStore } from '@metro-labs/core/automation-store';
import type { Activity } from './activity.js';
import { Automation } from './automation.js';
import { ActivityTasks } from './activity-tasks.js';
import { RunnerCalls } from './calls.js';
import { channelText, type ChannelEvent } from './channel-text.js';
import type { RunnerConfig } from './config.js';
import { Inbox, type Unanswered, type Uuid } from './inbox.js';
import { FRONT_RULES } from './rules.js';
import { INTERRUPTED_NOTICE } from './recovery.js';
import type { SessionStore } from './session-store.js';
import { completedCommand, SessionWatch, startedCommand, uuidsOf } from './session-watch.js';
import { TaskRecovery } from './task-recovery.js';
import { METRO_SERVER, type MetroTools } from './tool-proxy.js';

const STARTUP_WAIT = 'CLAUDE_CODE_MCP_STARTUP_WAIT_MS';
export const COMPACT_AT = 120_000;
export const COMPACT_IDLE_MS = 60_000;

const MODEL_PINS: ReadonlySet<string> = new Set(['ANTHROPIC_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']);

export function runnerEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const unpinned = Object.fromEntries(Object.entries(env).filter(([name]) => !MODEL_PINS.has(name)));
  const terminals = new Set((env.CLAUDE_CODE_TERMINAL_MCP_TOOLS ?? '').split(',').map((name) => name.trim()).filter(Boolean));
  terminals.add('mcp__metro__send');
  return { [STARTUP_WAIT]: '0', ...unpinned, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_TERMINAL_MCP_TOOLS: [...terminals].join(',') };
}

export type ModelSettings = Parameters<Query['applyFlagSettings']>[0];

export const allowedOnly = (model: string | null): ModelSettings =>
  model === null ? { availableModels: null, enforceAvailableModels: null } : { availableModels: [model], enforceAvailableModels: true };

export function runnerOptions(cfg: RunnerConfig, tools: MetroTools, canUseTool: CanUseTool, resume: string | null, env = process.env): Options {
  return {
    ...(cfg.model === null ? {} : { model: cfg.model }),
    cwd: cfg.cwd,
    env: runnerEnv(env),
    ...(cfg.claude === null ? {} : { pathToClaudeCodeExecutable: cfg.claude }),
    settingSources: ['user', 'project', 'local'],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: cfg.prompt === null ? FRONT_RULES : `${cfg.prompt}\n\n${FRONT_RULES}` },
    mcpServers: { [METRO_SERVER]: tools.config },
    permissionMode: cfg.permissionMode,
    allowDangerouslySkipPermissions: cfg.permissionMode === 'bypassPermissions',
    canUseTool,
    includePartialMessages: true,
    extraArgs: { 'system-prompt-snapshot': 'off' },
    ...(resume === null ? {} : { resume }),
    stderr: (text: string) => {
      log.debug({ text: text.slice(0, 500) }, 'sdk-runner: claude stderr');
    },
  };
}

export interface CompactState {
  context: number;
  floor: number | null;
  limit: number;
  busy: boolean;
}

export const compactDue = (s: CompactState): boolean => !s.busy && s.context >= s.limit && s.context - (s.floor ?? 0) >= s.limit / 2;

export type OpenSession = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;

export interface RunnerParts {
  store: SessionStore;
  readOnly: (tool: string) => boolean;
  compactAt?: number;
  open?: OpenSession;
  activity?: Activity;
  automationStore?: AutomationStore;
}

function streamOutput(event: Record<string, unknown>): boolean {
  if (event.type === 'content_block_start' && isRecord(event.content_block)) return event.content_block.type === 'tool_use';
  return event.type === 'content_block_delta' && isRecord(event.delta) && event.delta.type === 'text_delta' && typeof event.delta.text === 'string' && event.delta.text.length > 0;
}

function visibleOutput(m: Record<string, unknown>): boolean {
  if (m.type === 'assistant' && isRecord(m.message) && Array.isArray(m.message.content)) {
    return m.message.content.some((block: unknown) => isRecord(block) && (block.type === 'tool_use' || (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0)));
  }
  return m.type === 'stream_event' && isRecord(m.event) && streamOutput(m.event);
}

export class Runner {
  readonly inbox: Inbox;
  readonly calls: RunnerCalls;
  readonly automation: Automation | null;
  private readonly recovery: TaskRecovery;
  private readonly watch: SessionWatch;
  private readonly tasks = new ActivityTasks(() => undefined);
  private compactTimer: ReturnType<typeof setTimeout> | null = null;
  private session: Query | null = null;
  private sessionId: string | null = null;
  private compactAsked: Uuid | null = null;
  private compactFloor: number | null = null;
  private compacted = false;
  private model: string | null = null;
  private switching: Promise<void> = Promise.resolve();
  private ended = false;
  private readonly interrupted: number;
  private interruptionReported = false;

  constructor(private readonly parts: RunnerParts) {
    this.watch = new SessionWatch(parts.readOnly);
    this.inbox = new Inbox((unanswered) => { this.keep(unanswered); }, {
      ready: () => this.watch.admitting,
      dispatch: (message) => { this.automation?.dispatched(message.uuid); this.watch.dispatched(message.uuid); },
      input: (input) => { this.cancelCompact(); parts.activity?.input(input); },
      queue: (count, oldest) => { parts.activity?.pending(count, oldest); },
    });
    this.calls = new RunnerCalls(this.inbox, parts.activity);
    const { unanswered: again, interrupted, context, tasks } = parts.store.recover();
    this.recovery = new TaskRecovery(parts.store, this.inbox, tasks, interrupted, (err) => {
      log.error({ err: errMsg(err) }, 'sdk-runner: task recovery could not be saved');
      this.parts.activity?.fail(INTERRUPTED_NOTICE);
      this.close(false);
    }, Date.now, () => { parts.activity?.recovered(); });
    this.automation = parts.automationStore === undefined ? null : new Automation(parts.automationStore, this.inbox, (uuid, at) => {
      if (this.recovery.ledger.snapshot().some((task) => task.id === `input:${uuid}`)) return;
      this.recovery.ledger.interrupted([{ uuid, at, text: '' }], Date.now());
      this.recovery.start();
    }, (err) => {
      log.error({ err: errMsg(err) }, 'sdk-runner: local automation could not be saved');
      this.parts.activity?.fail('Local scheduled work could not be saved. Check metro task status before resuming.');
      this.close(false);
    });
    this.watch.restoreContext(context ?? 0);
    parts.activity?.recover(tasks);
    this.interrupted = interrupted.length;
    this.inbox.again(again);
    if (again.length > 0) log.info({ count: again.length }, 'sdk-runner: chat messages the last session never read go in again');
  }

  get id(): string | null { return this.sessionId; }

  start(options: Options): Query {
    if (this.session !== null) throw new Error('the runner was already started');
    if (options.resume === undefined) this.watch.restoreContext(0);
    else this.maybeCompact(true);
    this.session = (this.parts.open ?? query)({ prompt: this.inbox, options });
    this.model = options.model ?? null;
    this.queueModel(this.model);
    this.recovery.start();
    this.automation?.start();
    return this.session;
  }

  switchModel(model: string | null): Promise<void> {
    this.queueModel(model);
    return this.switching;
  }

  async run(observe?: (message: SDKMessage) => void): Promise<void> {
    if (this.session === null) throw new Error('the runner was not started');
    try {
      for await (const message of this.session) {
        if (this.ended) break;
        this.cancelCompact();
        if (message.type === 'system') this.tasks.observe(message);
        const m: Record<string, unknown> = { ...message };
        this.recovery.observe(m);
        this.automation?.observe(m);
        this.trackInput(m);
        this.watch.observe(m);
        this.note(m);
        this.parts.activity?.observe(message);
        this.inbox.notify();
        this.maybeCompact();
        observe?.(message);
      }
    } finally {
      this.cancelCompact();
      this.automation?.close(false);
      this.recovery.close(false);
      this.ended = true;
    }
  }

  chat(event: ChannelEvent): Uuid {
    try {
      const uuid = this.inbox.push('chat', channelText(METRO_SERVER, event.content, event.meta));
      this.calls.chat(event);
      return uuid;
    } catch (err) {
      log.error('sdk-runner: could not save incoming chat; stopping before further work');
      try {
        this.parts.activity?.fail(INTERRUPTED_NOTICE);
      } finally {
        this.close(false);
      }
      throw err;
    }
  }

  close(cancelActive = false): void {
    this.cancelCompact();
    this.calls.close();
    try {
      this.recovery.close(cancelActive);
      this.automation?.close(cancelActive);
    } finally {
      this.ended = true;
      this.inbox.close();
      this.session?.close();
    }
  }

  private queueModel(model: string | null): void {
    this.switching = this.switching
      .then(() => this.applyModel(model))
      .catch((err: unknown) => {
        this.parts.activity?.fail('The SDK could not apply the selected model. Check the Model page.');
        log.warn({ model, err: errMsg(err) }, 'sdk-runner: the session could not take the model the Model page picked');
      });
  }

  private async applyModel(model: string | null): Promise<void> {
    const session = this.session;
    if (session === null) return;
    await session.applyFlagSettings(allowedOnly(model));
    this.parts.activity?.connected();
    if (this.interrupted > 0 && !this.interruptionReported) {
      this.interruptionReported = true;
      this.parts.activity?.fail(INTERRUPTED_NOTICE);
      log.warn({ count: this.interrupted }, INTERRUPTED_NOTICE);
    }
    if (model === this.model) return;
    const was = this.model;
    await session.setModel(model ?? undefined);
    this.model = model;
    log.info({ was, now: model }, 'sdk-runner: the session thinks with the new model from now on, with no restart');
  }

  private trackInput(m: Record<string, unknown>): void {
    if (m.parent_tool_use_id !== null && m.parent_tool_use_id !== undefined) return;
    if (m.type === 'result') {
      const uuids = uuidsOf(m);
      if (uuids !== null) this.inbox.finished(uuids);
      this.inbox.boundary();
      return;
    }
    const completed = completedCommand(m);
    if (completed !== null) { this.inbox.finished([completed]); return; }
    const started = startedCommand(m);
    this.inbox.started([...(uuidsOf(m) ?? []), ...(started === null ? [] : [started])]);
    if (visibleOutput(m)) this.inbox.output();
  }

  private keep(unanswered: Unanswered[]): void { this.parts.store.saveUnanswered(unanswered); }

  private note(m: Record<string, unknown>): void {
    if (m.parent_tool_use_id !== null && m.parent_tool_use_id !== undefined) return;
    if (m.type === 'result') this.turnDone(m);
    if (m.type !== 'system') return;
    if (m.subtype === 'init') this.started(m);
    else if (m.subtype === 'compact_boundary') {
      this.compacted = true;
      this.compactFloor = null;
      this.parts.store.saveContext(0);
      log.info({ compact: m.compact_metadata }, 'sdk-runner: the conversation was compacted');
    }
  }

  private turnDone(m: Record<string, unknown>): void {
    const context = this.watch.context;
    log.info({ turnMs: m.duration_ms, context, costUsd: m.total_cost_usd, subtype: m.subtype }, 'sdk-runner: turn done');
    this.parts.store.saveContext(context);
    if (this.compactAsked !== null && uuidsOf(m)?.includes(this.compactAsked)) {
      this.compactAsked = null;
      if (!this.compacted) this.compactFloor = context;
    }
    if (this.compacted && context > 0) {
      this.compactFloor = context;
      this.compacted = false;
    }
  }

  private compactReady(resuming = false): boolean {
    const busy = this.ended || this.compactAsked !== null || !this.watch.safe || !this.watch.admitting || (!resuming && (this.calls.live || this.inbox.pending > 0 || this.tasks.running > 0));
    return compactDue({ context: this.watch.context, floor: this.compactFloor, limit: this.parts.compactAt ?? COMPACT_AT, busy });
  }

  private maybeCompact(resuming = false): void {
    if (!this.compactReady(resuming)) return;
    if (resuming) { this.askCompact(true); return; }
    this.compactTimer = setTimeout(() => {
      this.compactTimer = null;
      if (this.compactReady()) this.askCompact(false);
    }, COMPACT_IDLE_MS);
    this.compactTimer.unref();
  }

  private askCompact(resuming: boolean): void {
    this.compactAsked = this.inbox.compact();
    log.info({ context: this.watch.context, resuming }, 'sdk-runner: compacting at a safe idle boundary');
  }

  private cancelCompact(): void {
    if (this.compactTimer !== null) clearTimeout(this.compactTimer);
    this.compactTimer = null;
  }

  private started(m: Record<string, unknown>): void {
    const id = typeof m.session_id === 'string' ? m.session_id : null;
    if (id === null || id === this.sessionId) return;
    this.sessionId = id;
    log.info({ session: id, model: m.model, claude: m.claude_code_version }, 'sdk-runner: session up');
    try {
      this.parts.store.save(id);
    } catch (err) {
      log.warn({ err: errMsg(err) }, 'sdk-runner: could not keep the session id for the next start');
    }
  }
}
