import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { query, type CanUseTool, type Options, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { CHAT_ERROR_MAX, CHAT_MCP_HEADER, clip, type ReplyState, type TurnEvent } from '@metro-labs/core/chat';
import { approvalId } from '@metro-labs/core/ids';
import { errMsg, log } from '@metro-labs/core/log';
import { skillSourceRoot } from '@metro-labs/core/skill-source';
import { ChatParts } from './chat-parts.js';
import type { RunnerConfig } from './config.js';
import { allowedOnly, unpinnedEnv } from './runner.js';
import { projectFolder } from './session-store.js';

const CHAT_RULES = `You are talking with members of your organization in a chat on metro.box, Metro's web app. This chat is its own session, separate from your chat networks.
- Answer here, directly, in Markdown. The person sees your text and your tool calls as you work, so do the work yourself with your tools; you do not need background workers for it.
- Your metro send, reply and react tools post to chat networks, not here. Use them only when you are asked to message someone there.
- When several people write in this chat, each message starts with the name of the person who wrote it.
- When a connector call answers needs_approval, the person sees Approve and Deny in this chat. Say in one short line what waits, then stop. When they write that it is approved, repeat the same call with the approval id.`;

const BLOCKING_TOOLS = ['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode'];
const APPROVAL_WAIT_MS = 30 * 60_000;
const DENIED = 'The person in this chat did not approve this.';

export interface ChatRequest {
  prompt: string;
  resume: string | null;
}

export type ChatOutput = TurnEvent | { t: 'session'; id: string };

export const chatEnv = (env: NodeJS.ProcessEnv): Record<string, string | undefined> => ({ CLAUDE_CODE_MCP_STARTUP_WAIT_MS: '0', ...unpinnedEnv(env), DISABLE_AUTOUPDATER: '1', METRO_SESSION: 'chat' });

export function chatOptions(cfg: RunnerConfig, resume: string | null, canUseTool: CanUseTool, env = process.env): Options {
  return {
    ...(cfg.model === null ? {} : { model: cfg.model }),
    cwd: cfg.cwd,
    env: chatEnv(env),
    ...(cfg.claude === null ? {} : { pathToClaudeCodeExecutable: cfg.claude }),
    settingSources: ['user', 'project', 'local'],
    additionalDirectories: [skillSourceRoot(cfg.claudeDir)],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: cfg.prompt === null ? CHAT_RULES : `${cfg.prompt}\n\n${CHAT_RULES}` },
    mcpServers: { metro: { type: 'http', url: cfg.mcpUrl, headers: { authorization: `Bearer ${cfg.key}`, [CHAT_MCP_HEADER]: '1' } } },
    disallowedTools: BLOCKING_TOOLS,
    permissionMode: cfg.permissionMode,
    allowDangerouslySkipPermissions: cfg.permissionMode === 'bypassPermissions',
    canUseTool,
    includePartialMessages: true,
    ...(resume === null ? {} : { resume }),
  };
}

export const kept = (claudeDir: string, cwd: string, session: string | null): string | null =>
  session !== null && existsSync(join(claudeDir, 'projects', projectFolder(cwd), `${session}.jsonl`)) ? session : null;

const userMessage = (prompt: string): SDKUserMessage => ({
  type: 'user',
  message: { role: 'user', content: prompt },
  parent_tool_use_id: null,
  uuid: randomUUID(),
});

function resultState(message: Extract<SDKMessage, { type: 'result' }>, stopped: boolean): { state: ReplyState; error: string | null } {
  if (stopped) return { state: 'stopped', error: null };
  if (message.subtype === 'success' && !message.is_error) return { state: 'done', error: null };
  const said = message.subtype === 'success' ? message.result : message.errors.join('; ');
  return { state: 'error', error: clip(said === '' ? 'The agent could not finish this reply.' : said, CHAT_ERROR_MAX) };
}

export class ChatTurn {
  private readonly parts: ChatParts;
  private readonly waiting = new Map<string, (allow: boolean) => void>();
  private session: Query | null = null;
  private sessionId: string | null = null;
  private stopped = false;
  private ended = false;

  constructor(private readonly emit: (output: ChatOutput) => void) {
    this.parts = new ChatParts(emit);
  }

  answer(id: string, allow: boolean): void {
    this.waiting.get(id)?.(allow);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const resolve of this.waiting.values()) resolve(false);
    await this.session?.interrupt().catch((err: unknown) => {
      log.warn({ err: errMsg(err) }, 'chat: the turn could not be interrupted');
    });
  }

  private readonly canUseTool: CanUseTool = async (tool, input, options) => {
    const id = approvalId();
    const n = this.parts.ask(id, tool, input);
    if (n === null || this.stopped) return { behavior: 'deny', message: DENIED };
    const allow = await this.decision(id, options.signal);
    this.parts.answered(n, allow ? 'allowed' : 'denied');
    return allow && !options.signal.aborted ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: DENIED };
  };

  private decision(id: string, signal: AbortSignal): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return new Promise<boolean>((resolve) => {
      this.waiting.set(id, resolve);
      signal.addEventListener('abort', () => { resolve(false); }, { once: true });
      timer = setTimeout(() => { resolve(false); }, APPROVAL_WAIT_MS);
    }).finally(() => {
      this.waiting.delete(id);
      clearTimeout(timer);
    });
  }

  private done(state: ReplyState, error: string | null): void {
    if (this.ended) return;
    this.ended = true;
    this.emit({ t: 'done', state, error });
  }

  private noteSession(message: SDKMessage): void {
    if (this.sessionId !== null || !('session_id' in message) || typeof message.session_id !== 'string' || message.session_id === '') return;
    this.sessionId = message.session_id;
    this.emit({ t: 'session', id: message.session_id });
  }

  async run(cfg: RunnerConfig, request: ChatRequest): Promise<void> {
    let finish = (): void => undefined;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    async function* input(): AsyncGenerator<SDKUserMessage> {
      yield userMessage(request.prompt);
      await finished;
    }
    const session = query({ prompt: input(), options: chatOptions(cfg, kept(cfg.claudeDir, cfg.cwd, request.resume), this.canUseTool) });
    this.session = session;
    session.applyFlagSettings(allowedOnly(cfg.model)).catch((err: unknown) => {
      log.warn({ err: errMsg(err) }, 'chat: the session could not be held to the Gateway page model');
    });
    try {
      for await (const message of session) {
        this.noteSession(message);
        this.parts.take(message);
        if (message.type !== 'result') continue;
        const { state, error } = resultState(message, this.stopped);
        this.done(state, error);
        break;
      }
      this.done(this.stopped ? 'stopped' : 'error', this.stopped ? null : 'The agent stopped before it finished this reply.');
    } catch (err) {
      log.warn({ err: errMsg(err) }, 'chat: the turn failed');
      this.done(this.stopped ? 'stopped' : 'error', this.stopped ? null : clip(errMsg(err), CHAT_ERROR_MAX));
    } finally {
      finish();
      session.close();
    }
  }
}
