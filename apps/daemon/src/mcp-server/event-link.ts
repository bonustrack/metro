import { errMsg, log } from '@metro-labs/core/log';
import { MCP_INBOX_WAIT_MS, MCP_PATHS, MCP_SETTLED_MAX, mcpInboxOf, type McpConnectorEvent, type McpEventOutcome } from '@metro-labs/http/mcp-server-protocol';
import { readAgentKey, type AgentKey } from '../connectors/agent-key.js';
import { agentCall, type AgentFetch, type MetroApi } from '../connectors/metro-api.js';
import { mcpServerUrl } from './config.js';
import { backoff, enrolledKey, pause, refusedWith } from './loop.js';

export type TakeEvent = (event: McpConnectorEvent) => McpEventOutcome | null;

export interface EventTiming {
  retryMs: number;
  retryMaxMs: number;
  idleMs: number;
  minPollMs: number;
  pollTimeoutMs: number;
  olderServerMs: number;
}

interface EventLinkDeps {
  url: string;
  owner: () => string | null;
  key: () => AgentKey | null;
  take: TakeEvent;
  fetch?: AgentFetch;
  timing?: Partial<EventTiming>;
}

const TIMING: EventTiming = { retryMs: 2_000, retryMaxMs: 60_000, idleMs: 30_000, minPollMs: 1_000, pollTimeoutMs: MCP_INBOX_WAIT_MS + 15_000, olderServerMs: 5 * 60_000 };
const ANSWER_MAX = 2 * 1024 * 1024;

export class McpEventLink {
  private readonly api: MetroApi;
  private readonly timing: EventTiming;
  private readonly unsent = new Map<string, McpEventOutcome>();
  private readonly abort = new AbortController();
  private failures = 0;
  private older = false;
  private running: Promise<void> | null = null;

  constructor(private readonly deps: EventLinkDeps) {
    this.api = { base: deps.url, fetch: deps.fetch ?? ((url, init) => fetch(url, init)), now: () => Date.now() };
    this.timing = { ...TIMING, ...deps.timing };
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

  private async run(): Promise<void> {
    while (!this.abort.signal.aborted) {
      const key = enrolledKey(this.deps.key, this.deps.owner);
      await pause(key === null ? this.timing.idleMs : await this.step(key), this.abort.signal);
    }
  }

  private async step(key: AgentKey): Promise<number> {
    const started = Date.now();
    const settled = [...this.unsent].slice(0, MCP_SETTLED_MAX).map(([id, outcome]) => ({ id, outcome }));
    try {
      const answer = await agentCall(this.api, key, MCP_PATHS.inbox, { settled }, { signal: this.abort.signal, timeoutMs: this.timing.pollTimeoutMs, answerMax: ANSWER_MAX });
      for (const entry of settled) this.unsent.delete(entry.id);
      this.failures = 0;
      this.older = false;
      for (const event of mcpInboxOf(answer)) this.take(event);
      return this.timing.minPollMs - (Date.now() - started);
    } catch (err) {
      return this.abort.signal.aborted ? 0 : this.failed(err);
    }
  }

  private take(event: McpConnectorEvent): void {
    try {
      const outcome = this.deps.take(event);
      if (outcome !== null) this.unsent.set(event.id, outcome);
    } catch (err) {
      log.warn({ event: event.id, err: errMsg(err) }, 'mcp-server: a connector event could not be handed to the session; it comes again');
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
    return backoff(this.timing, this.failures);
  }
}

let active: McpEventLink | null = null;

export function watchConnectorEvents(watch: { owner: () => string | null; take: TakeEvent }, env: NodeJS.ProcessEnv = process.env): boolean {
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
