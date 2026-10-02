import { randomUUID } from 'node:crypto';
import { query, type CanUseTool, type Options, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { errMsg, log } from '@metro-labs/core/log';
import { channelText, type ChannelEvent } from './channel-text.js';
import type { RunnerConfig } from './config.js';
import { Inbox, type Unanswered, type Uuid } from './inbox.js';
import { CALL_ENDED, callStarted, callWords, FRONT_RULES } from './rules.js';
import type { SessionStore } from './session-store.js';
import { SessionWatch, startedCommand, uuidsOf } from './session-watch.js';
import { SpeechRouter, type SpeechSink } from './speech.js';
import { METRO_SERVER, type MetroTools } from './tool-proxy.js';

const STARTUP_WAIT = 'CLAUDE_CODE_MCP_STARTUP_WAIT_MS';
const STALL_MS = 2_000;
export const COMPACT_AT = 120_000;

const MODEL_PINS: ReadonlySet<string> = new Set(['ANTHROPIC_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']);

export function runnerEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const unpinned = Object.fromEntries(Object.entries(env).filter(([name]) => !MODEL_PINS.has(name)));
  return { [STARTUP_WAIT]: '0', ...unpinned, DISABLE_AUTOUPDATER: '1' };
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
  sink: SpeechSink;
  readOnly: (tool: string) => boolean;
  compactAt?: number;
  open?: OpenSession;
}

export class Runner {
  readonly inbox: Inbox;
  private readonly speech: SpeechRouter;
  private readonly watch: SessionWatch;
  private session: Query | null = null;
  private sessionId: string | null = null;
  private compactAsked = false;
  private compactFloor: number | null = null;
  private stall: ReturnType<typeof setTimeout> | null = null;
  private model: string | null = null;
  private switching: Promise<void> = Promise.resolve();

  constructor(private readonly parts: RunnerParts) {
    this.inbox = new Inbox((unanswered) => {
      this.keep(unanswered);
    });
    this.speech = new SpeechRouter((uuid) => this.inbox.kindOf(uuid), {
      say: (text) => {
        this.clearStall();
        parts.sink.say(text);
      },
      done: () => {
        parts.sink.done();
      },
    });
    this.watch = new SessionWatch(parts.readOnly);
  }

  get id(): string | null {
    return this.sessionId;
  }

  start(options: Options): Query {
    const again = this.parts.store.unanswered();
    this.inbox.again(again);
    if (again.length > 0) log.info({ count: again.length }, 'sdk-runner: chat messages the last session never read go in again');
    this.session = (this.parts.open ?? query)({ prompt: this.inbox, options });
    this.model = options.model ?? null;
    this.queueModel(this.model);
    return this.session;
  }

  switchModel(model: string | null): Promise<void> {
    this.queueModel(model);
    return this.switching;
  }

  async run(observe?: (message: SDKMessage) => void): Promise<void> {
    if (this.session === null) throw new Error('the runner was not started');
    for await (const message of this.session) {
      const m: Record<string, unknown> = { ...message };
      const started = startedCommand(m);
      this.inbox.consumed([...(uuidsOf(m) ?? []), ...(started === null ? [] : [started])]);
      this.watch.observe(m);
      this.speech.observe(message);
      this.note(m);
      observe?.(message);
    }
  }

  chat(event: ChannelEvent): Uuid {
    return this.inbox.push('chat', channelText(METRO_SERVER, event.content, event.meta));
  }

  callStarted(where: string): Uuid {
    this.speech.setCallLive(true);
    return this.callPush(callStarted(where));
  }

  heard(text: string): Uuid {
    return this.callPush(callWords(text));
  }

  callEnded(): Uuid {
    this.speech.setCallLive(false);
    this.clearStall();
    return this.inbox.push('note', CALL_ENDED);
  }

  close(): void {
    this.clearStall();
    this.inbox.close();
    this.session?.close();
  }

  private callPush(text: string): Uuid {
    const uuid = randomUUID();
    this.inbox.mark(uuid, 'call');
    this.armStall();
    if (this.watch.compacting) log.info('sdk-runner: a call message waits for the compaction to finish');
    this.watch
      .whenNotCompacting()
      .then(() => this.watch.whenNotWriting())
      .then(() => this.inbox.push('call', text, 'now', uuid))
      .catch((err: unknown) => {
        log.warn({ err: errMsg(err) }, 'sdk-runner: could not hand a call message to the session');
      });
    return uuid;
  }

  private armStall(): void {
    this.clearStall();
    if (this.parts.sink.stalled === undefined) return;
    this.stall = setTimeout(() => {
      this.stall = null;
      if (this.speech.callLive && !this.speech.talking) this.parts.sink.stalled?.();
    }, STALL_MS);
    this.stall.unref();
  }

  private clearStall(): void {
    if (this.stall !== null) clearTimeout(this.stall);
    this.stall = null;
  }

  private queueModel(model: string | null): void {
    this.switching = this.switching
      .then(() => this.applyModel(model))
      .catch((err: unknown) => {
        log.warn({ model, err: errMsg(err) }, 'sdk-runner: the session could not take the model the Model page picked');
      });
  }

  private async applyModel(model: string | null): Promise<void> {
    const session = this.session;
    if (session === null) return;
    await session.applyFlagSettings(allowedOnly(model));
    if (model === this.model) return;
    const was = this.model;
    await session.setModel(model ?? undefined);
    this.model = model;
    log.info({ was, now: model }, 'sdk-runner: the session thinks with the new model from now on, with no restart');
  }

  private keep(unanswered: Unanswered[]): void {
    try {
      this.parts.store.saveUnanswered(unanswered);
    } catch (err) {
      log.warn({ err: errMsg(err) }, 'sdk-runner: could not keep the unanswered chat messages');
    }
  }

  private note(m: Record<string, unknown>): void {
    if (m.type === 'system' && m.subtype === 'init') this.started(m);
    else if (m.type === 'result') this.turnDone(m);
    else if (m.type === 'system' && (m.subtype === 'task_started' || m.subtype === 'task_notification')) log.info({ task: m.task_id, status: m.status ?? 'started' }, `sdk-runner: worker ${m.subtype}`);
    else if (m.type === 'system' && m.subtype === 'compact_boundary') {
      this.compactAsked = false;
      this.compactFloor = null;
      log.info({ compact: m.compact_metadata }, 'sdk-runner: the conversation was compacted');
    }
  }

  private turnDone(m: Record<string, unknown>): void {
    log.info({ turnMs: m.duration_ms, context: this.watch.context, costUsd: m.total_cost_usd, subtype: m.subtype }, 'sdk-runner: turn done');
    const limit = this.parts.compactAt ?? COMPACT_AT;
    const context = this.watch.context;
    if (context > 0) this.compactFloor ??= context;
    if (!compactDue({ context, floor: this.compactFloor, limit, busy: this.compactAsked || this.speech.callLive || this.watch.compacting })) return;
    this.compactAsked = true;
    log.info({ context: this.watch.context }, 'sdk-runner: compacting while no call is live');
    this.inbox.push('note', '/compact');
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
