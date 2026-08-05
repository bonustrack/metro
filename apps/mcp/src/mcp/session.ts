import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InboundRelay } from '../channels/inbound.js';
import { ChannelRelay, type ReplayLedger } from '../channels/relay.js';
import { errMsg } from '../daemon/log.js';
import {
  allowlistForLine,
  senderMatchesAllowlist,
} from '../db/agent-map.js';
import { accountStationNames } from '../stations/registry.js';
import { MCP_INSTRUCTIONS } from './tool-schemas.js';
import { ChannelOwner } from './channel-owner.js';
import { BoundedEventStore } from './event-store.js';
import { registerPermissionRelay } from './permission-relay.js';
import { registerToolHandlers } from './tool-dispatch.js';
import type { RawGetSink } from './raw-get-stream.js';
import type { RequestIdentity } from './request-identity.js';

export const channelLog = (...a: unknown[]): void => {
  console.error('[metro-mcp]', ...a);
};

const parseList = (raw: string): string[] =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const getStations = (): Set<string> =>
  new Set(
    parseList(
      process.env.METRO_CHANNEL_STATIONS ?? accountStationNames().join(','),
    ),
  );

const senderAllowed = (from: string, line: string): boolean => {
  const allowlist = allowlistForLine(line);
  return allowlist ? senderMatchesAllowlist(allowlist, from) : true;
};

interface AdoptableInner {
  sessionId?: string;
  _initialized?: boolean;
}

function makeTransport(
  id: string,
  eventStore: BoundedEventStore,
  adopted: boolean,
): StreamableHTTPServerTransport {
  const t = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => id,
    eventStore,
  });
  if (!adopted) return t;
  const inner = (t as unknown as { _webStandardTransport?: AdoptableInner })
    ._webStandardTransport;
  if (inner) {
    inner.sessionId = id;
    inner._initialized = true;
  }
  return t;
}

export interface SessionInit {
  id: string;
  scopeKey: string;
  adopted: boolean;
  ledger: ReplayLedger;
  onClosed: (session: McpSession) => void;
}

export class McpSession {
  readonly id: string;
  readonly scopeKey: string;
  readonly owner = new ChannelOwner();
  readonly eventStore: BoundedEventStore;
  readonly transport: StreamableHTTPServerTransport;
  readonly server: Server;
  readonly relay: InboundRelay;
  readonly channel: ChannelRelay;
  lastSeenAt = Date.now();
  private sink: RawGetSink | undefined;
  private unsubscribe: (() => void) | undefined;
  private closed = false;
  private schemaNoticeDue: boolean;
  private readonly onClosed: (session: McpSession) => void;

  private constructor(init: SessionInit) {
    this.id = init.id;
    this.scopeKey = init.scopeKey;
    this.schemaNoticeDue = init.adopted;
    this.onClosed = init.onClosed;
    this.eventStore = new BoundedEventStore({
      scopeOf: () => this.owner.scope(),
    });
    this.transport = makeTransport(init.id, this.eventStore, init.adopted);
    this.server = new Server(
      { name: 'metro', version: '0.1.0' },
      {
        capabilities: {
          experimental: {
            'claude/channel': {},
            'claude/channel/permission': {},
          },
          tools: { listChanged: true },
        },
        instructions: MCP_INSTRUCTIONS,
      },
    );
    registerToolHandlers(this.server);
    this.relay = new InboundRelay({
      mcp: this.server,
      log: channelLog,
      getStations,
      senderAllowed,
    });
    registerPermissionRelay({
      mcp: this.server,
      relay: this.relay,
      owner: this.owner,
      log: channelLog,
    });
    this.channel = new ChannelRelay({
      relay: this.relay,
      log: channelLog,
      inScope: (line) => this.owner.inScope(line),
      ledger: init.ledger,
    });
  }

  static async open(init: SessionInit): Promise<McpSession> {
    const session = new McpSession(init);
    await session.server.connect(session.transport);
    session.server.onclose = (): void => {
      void session.close();
    };
    return session;
  }

  get streamAttached(): boolean {
    return this.sink !== undefined && !this.sink.closed;
  }

  get currentSink(): RawGetSink | undefined {
    return this.sink;
  }

  touch(): void {
    this.lastSeenAt = Date.now();
  }

  startChannel(): void {
    this.unsubscribe ??= this.channel.start();
  }

  bindSink(sink: RawGetSink | undefined, identity: RequestIdentity): void {
    this.sink = sink;
    if (sink === undefined) {
      this.owner.releaseStream();
      return;
    }
    this.owner.bindStream(identity);
    this.announceToolSchema();
  }

  private announceToolSchema(): void {
    if (!this.schemaNoticeDue) return;
    this.schemaNoticeDue = false;
    channelLog('session: tool list changed', 'id', this.id, 'scope', this.scopeKey);
    void this.server.sendToolListChanged().catch((err: unknown) => {
      channelLog('session: tool list changed notice failed', errMsg(err));
    });
  }

  dropStream(): void {
    const sink = this.sink;
    this.sink = undefined;
    this.owner.releaseStream();
    sink?.close();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onClosed(this);
    this.dropStream();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.server.close().catch(() => undefined);
  }
}
