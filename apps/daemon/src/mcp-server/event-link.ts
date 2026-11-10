import { errMsg, log } from '@metro-labs/core/log';
import { MCP_INBOX_WAIT_MS, MCP_PATHS, mcpInboxOf } from '@metro-labs/http/mcp-server-protocol';
import { readAgentKey, type AgentKey } from '../connectors/agent-key.js';
import { agentCall, MetroApiRefusal, type AgentFetch, type MetroApi } from '../connectors/metro-api.js';
import { mcpServerUrl } from './config.js';
import { EventIntake, type TakeEvent } from './event-intake.js';

export interface EventTiming {
  retryMs: number;
  retryMaxMs: number;
  idleMs: number;
  minPollMs: number;
  pollTimeoutMs: number;
  olderServerMs: number;
}

export interface EventLinkDeps {
  url: string;
  owner: () => string | null;
  key: () => AgentKey | null;
  take: TakeEvent;
  fetch?: AgentFetch;
  timing?: Partial<EventTiming>;
}

const TIMING: EventTiming = { retryMs: 2_000, retryMaxMs: 60_000, idleMs: 30_000, minPollMs: 1_000, pollTimeoutMs: MCP_INBOX_WAIT_MS + 15_000, olderServerMs: 5 * 60_000 };
const ANSWER_MAX = 2 * 1024 * 1024;

const refusedWith = (err: unknown, status: number): boolean => err instanceof MetroApiRefusal && err.upstreamStatus === status;

export class McpEventLink {
  private readonly api: MetroApi;
  private readonly timing: EventTiming;
  private readonly intake: EventIntake;
  private readonly abort = new AbortController();
  private failures = 0;
  private older = false;
  private running: Promise<void> | null = null;

  constructor(private readonly deps: EventLinkDeps) {
    this.api = { base: deps.url, fetch: deps.fetch ?? ((url, init) => fetch(url, init)), now: () => Date.now() };
    this.timing = { ...TIMING, ...deps.timing };
    this.intake = new EventIntake(deps.take);
  }

  private get stopped(): boolean {
    return this.abort.signal.aborted;
  }

  start(): void {
    this.running ??= this.run().catch((err: unknown) => {
      log.error({ err: errMsg(err) }, 'mcp-server: the connector event loop stopped');
    });
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.running;
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
      if (key === null) await this.pause(this.timing.idleMs);
      else await this.pause(await this.step(key));
    }
  }

  private async step(key: AgentKey): Promise<number> {
    const started = Date.now();
    const settled = this.intake.settled();
    try {
      const answer = await agentCall(this.api, key, MCP_PATHS.inbox, { settled }, { signal: this.abort.signal, timeoutMs: this.timing.pollTimeoutMs, answerMax: ANSWER_MAX });
      this.intake.sent(settled);
      this.failures = 0;
      this.older = false;
      return this.intake.receive(mcpInboxOf(answer)) > 0 ? 0 : Math.max(0, this.timing.minPollMs - (Date.now() - started));
    } catch (err) {
      if (this.stopped) return 0;
      return this.failed(err);
    }
  }

  private failed(err: unknown): number {
    if (refusedWith(err, 404)) {
      if (!this.older) log.info({ server: this.deps.url }, 'mcp-server: this server has no connector events yet, so Metro asks again every few minutes');
      this.older = true;
      return this.timing.olderServerMs;
    }
    this.failures += 1;
    if (this.failures === 1 || this.failures % 20 === 0) log.warn({ server: this.deps.url, failures: this.failures, err: errMsg(err) }, 'mcp-server: could not ask for connector events; trying again');
    return Math.min(this.timing.retryMs * 2 ** Math.min(this.failures - 1, 20), this.timing.retryMaxMs);
  }

  private pause(ms: number): Promise<void> {
    if (this.stopped || ms <= 0) return Promise.resolve();
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

let active: McpEventLink | null = null;

export interface ConnectorEventWatch {
  owner: () => string | null;
  take: TakeEvent;
}

export function watchConnectorEvents(watch: ConnectorEventWatch, env: NodeJS.ProcessEnv = process.env): boolean {
  const url = mcpServerUrl(env);
  if (url === null || active !== null) return false;
  active = new McpEventLink({ url, owner: watch.owner, key: () => readAgentKey(), take: watch.take });
  active.start();
  log.info({ server: url }, 'mcp-server: connector events come from this server once the agent is enrolled');
  return true;
}

export async function stopConnectorEvents(): Promise<void> {
  const link = active;
  active = null;
  await link?.stop();
}
