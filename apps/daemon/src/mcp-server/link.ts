import { errMsg, log } from '@metro-labs/core/log';
import { MCP_APPROVAL_WAIT_MS, MCP_PATHS, mcpApprovalsOf, type McpApproval, type McpDecision } from '@metro-labs/http/mcp-server-protocol';
import { agentsDir } from '../agents/files.js';
import { readAgentKey, type AgentKey } from '../connectors/agent-key.js';
import { agentCall, MetroApiRefusal, type AgentFetch, type MetroApi } from '../connectors/metro-api.js';
import { mcpServerUrl } from './config.js';
import { ensureMcpToken } from './token.js';

export type AnswerOutcome = 'acknowledged' | 'gone' | 'stopped';

export type HoldApproval = (approval: McpApproval, answer: (decision: McpDecision) => Promise<AnswerOutcome>) => void;

export interface McpTiming {
  retryMs: number;
  retryMaxMs: number;
  idleMs: number;
  minPollMs: number;
  pollTimeoutMs: number;
}

export interface McpLinkDeps {
  url: string;
  owner: () => string | null;
  key: () => AgentKey | null;
  dir: () => string;
  hold: HoldApproval;
  fetch?: AgentFetch;
  timing?: Partial<McpTiming>;
}

const TIMING: McpTiming = { retryMs: 2_000, retryMaxMs: 60_000, idleMs: 30_000, minPollMs: 1_000, pollTimeoutMs: MCP_APPROVAL_WAIT_MS + 15_000 };
const APPROVALS_MAX = 256 * 1024;

const refusedWith = (err: unknown, status: number): boolean => err instanceof MetroApiRefusal && err.upstreamStatus === status;

export class McpServerLink {
  private readonly api: MetroApi;
  private readonly timing: McpTiming;
  private readonly abort = new AbortController();
  private registered: string | null = null;
  private failures = 0;
  private running: Promise<void> | null = null;

  constructor(private readonly deps: McpLinkDeps) {
    this.api = { base: deps.url, fetch: deps.fetch ?? ((url, init) => fetch(url, init)), now: () => Date.now() };
    this.timing = { ...TIMING, ...deps.timing };
  }

  private get stopped(): boolean {
    return this.abort.signal.aborted;
  }

  start(): void {
    this.running ??= this.run().catch((err: unknown) => {
      log.error({ err: errMsg(err) }, 'mcp-server: the token and approval loop stopped');
    });
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.running;
  }

  async answer(id: string, decision: McpDecision): Promise<AnswerOutcome> {
    for (let attempt = 0; !this.stopped; attempt += 1) {
      if (attempt > 0) await this.pause(this.delay(attempt));
      const key = this.enrolledKey();
      if (key === null || this.stopped) continue;
      try {
        await agentCall(this.api, key, MCP_PATHS.answer, { id, decision }, { signal: this.abort.signal });
        log.info({ id, decision }, 'mcp-server: the owner answer reached the server');
        return 'acknowledged';
      } catch (err) {
        if (refusedWith(err, 404)) return 'gone';
        if (refusedWith(err, 401)) this.registered = null;
        if (!this.stopped) log.warn({ id, attempt: attempt + 1, err: errMsg(err) }, 'mcp-server: the owner answer did not reach the server; trying again');
      }
    }
    return 'stopped';
  }

  private enrolledKey(): AgentKey | null {
    try {
      const key = this.deps.key();
      const owner = this.deps.owner();
      return key !== null && owner !== null && key.enrollment?.organization === owner ? key : null;
    } catch (err) {
      log.warn({ err: errMsg(err) }, 'mcp-server: the agent key could not be read');
      return null;
    }
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const key = this.enrolledKey();
      if (key === null) {
        this.registered = null;
        await this.pause(this.timing.idleMs);
      } else if (await this.step(key)) this.failures = 0;
      else await this.pause(this.delay(++this.failures));
    }
  }

  private async step(key: AgentKey): Promise<boolean> {
    let doing = 'register the MCP token';
    try {
      await this.register(key);
      doing = 'ask for approvals';
      await this.poll(key);
      return true;
    } catch (err) {
      if (this.stopped) return true;
      if (refusedWith(err, 401)) this.registered = null;
      log.warn({ server: this.deps.url, failures: this.failures + 1, err: errMsg(err) }, `mcp-server: could not ${doing}; trying again`);
      return false;
    }
  }

  private async register(key: AgentKey): Promise<void> {
    const token = ensureMcpToken(key.keyId, this.deps.dir());
    if (token.fresh) log.info({ keyId: key.keyId }, 'mcp-server: made a new MCP token for this agent');
    const binding = `${key.keyId} ${token.hash}`;
    if (this.registered === binding) return;
    await agentCall(this.api, key, MCP_PATHS.token, { tokenHash: token.hash }, { signal: this.abort.signal });
    this.registered = binding;
    log.info({ server: this.deps.url, keyId: key.keyId }, 'mcp-server: the MCP token is registered');
  }

  private async poll(key: AgentKey): Promise<void> {
    const started = Date.now();
    const answer = await agentCall(this.api, key, MCP_PATHS.approvals, {}, { signal: this.abort.signal, timeoutMs: this.timing.pollTimeoutMs, answerMax: APPROVALS_MAX });
    const approvals = mcpApprovalsOf(answer);
    for (const approval of approvals) this.receive(approval);
    const rest = this.timing.minPollMs - (Date.now() - started);
    if (approvals.length === 0 && rest > 0) await this.pause(rest);
  }

  private receive(approval: McpApproval): void {
    try {
      this.deps.hold(approval, (decision) => this.answer(approval.id, decision));
    } catch (err) {
      log.warn({ id: approval.id, err: errMsg(err) }, 'mcp-server: an approval could not be held');
    }
  }

  private delay(attempt: number): number {
    return Math.min(this.timing.retryMs * 2 ** Math.min(attempt - 1, 20), this.timing.retryMaxMs);
  }

  private pause(ms: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const signal = this.abort.signal;
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref();
      signal.addEventListener('abort', done, { once: true });
    });
  }
}

let active: McpServerLink | null = null;

export interface McpServerWatch {
  owner: () => string | null;
  hold: HoldApproval;
}

export function watchMcpServer(watch: McpServerWatch, env: NodeJS.ProcessEnv = process.env): boolean {
  const url = mcpServerUrl(env);
  if (url === null || active !== null) return false;
  active = new McpServerLink({ url, owner: watch.owner, key: () => readAgentKey(), dir: agentsDir, hold: watch.hold });
  active.start();
  log.info({ server: url }, 'mcp-server: connector approvals relay from this server once the agent is enrolled');
  return true;
}

export async function stopMcpServer(): Promise<void> {
  const link = active;
  active = null;
  await link?.stop();
}
