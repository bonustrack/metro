import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InboundRelay } from '../channels/inbound.js';
import { answerPrompt, forgetPromptsOf, promptLine } from '../approvals/pending.js';
import { ChannelRelay, type ReplayLedger } from '../channels/relay.js';
import { errMsg } from '@metro-labs/core/log';
import { allowlistForLine, senderPermitted } from '../agents/map.js';
import { accountStationNames, stationByName } from '../stations/registry.js';
import { eventInScope } from '../agents/scope.js';
import { MCP_INSTRUCTIONS } from './instructions.js';
import { BoundedEventStore } from './event-store.js';
import { registerPermissionRelay } from './permission-relay.js';
import { registerToolHandlers, toolSchemaSignature } from './tool-dispatch.js';
import { web, type RawGetSink } from './raw-get-stream.js';

export const channelLog = (...a: unknown[]): void => {
  console.error('[metro-mcp]', ...a);
};

const getStations = (): Set<string> => new Set(accountStationNames());

const senderAllowed = (from: string, line: string, verified?: boolean): boolean =>
  senderPermitted(allowlistForLine(line), from, verified);

const approves = (station: string): boolean => stationByName(station)?.approvals !== false;

async function answerPermission(requestId: string, behavior: 'allow' | 'deny', line: string): Promise<boolean> {
  if (promptLine(requestId) !== line) return false;
  return (await answerPrompt(requestId, behavior, 'chat', line)) !== undefined;
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
  const inner = web(t);
  if (inner) {
    inner.sessionId = id;
    inner._initialized = true;
  }
  return t;
}

export interface SessionInit {
  id: string;
  scope: Set<string>;
  adopted: boolean;
  ledger: ReplayLedger;
  onClosed: (session: McpSession) => void;
}

export class McpSession {
  readonly id: string;
  readonly scope: Set<string>;
  readonly eventStore: BoundedEventStore;
  readonly transport: StreamableHTTPServerTransport;
  readonly server: Server;
  readonly relay: InboundRelay;
  readonly channel: ChannelRelay;
  private sink: RawGetSink | undefined;
  private unsubscribe: (() => void) | undefined;
  private closed = false;
  private issuedSchema: string | undefined;
  private announcing = false;
  private readonly onClosed: (session: McpSession) => void;

  private constructor(init: SessionInit) {
    this.id = init.id;
    this.scope = init.scope;
    this.issuedSchema = init.adopted ? undefined : toolSchemaSignature();
    this.onClosed = init.onClosed;
    this.eventStore = new BoundedEventStore();
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
    registerToolHandlers(this.server, {
      markCurrent: (): void => {
        this.issuedSchema = toolSchemaSignature();
      },
      deliver: (send): void => {
        this.deliverSchemaNotice(send, 'request');
      },
    }, {
      onSent: (id): void => {
        this.relay.noteSent(id);
      },
    });
    this.relay = new InboundRelay({
      mcp: this.server,
      log: channelLog,
      getStations,
      senderAllowed,
      approves,
      answerPermission,
    });
    registerPermissionRelay({
      mcp: this.server,
      relay: this.relay,
      inScope: (line) => this.inScope(line),
      log: channelLog,
    });
    this.channel = new ChannelRelay({
      relay: this.relay,
      log: channelLog,
      inScope: (line) => this.inScope(line),
      ledger: init.ledger,
    });
  }

  static async open(init: SessionInit): Promise<McpSession> {
    const session = new McpSession(init);
    await session.server.connect(session.transport);
    session.server.onclose = (): void => {
      session.close().catch((err: unknown) => {
        channelLog('session: close failed', 'id', init.id, errMsg(err));
      });
    };
    return session;
  }

  get streamAttached(): boolean {
    return this.sink !== undefined && !this.sink.closed;
  }

  get currentSink(): RawGetSink | undefined {
    return this.sink;
  }

  inScope(line: string): boolean {
    return this.streamAttached && eventInScope(this.scope, line);
  }

  startChannel(): void {
    this.unsubscribe ??= this.channel.start();
  }

  bindSink(sink: RawGetSink | undefined): void {
    this.sink = sink;
    if (sink !== undefined) this.announceToolSchema();
  }

  private get schemaNoticeDue(): boolean {
    return this.issuedSchema !== toolSchemaSignature();
  }

  private announceToolSchema(): void {
    if (!this.streamAttached) return;
    this.deliverSchemaNotice(
      () => this.server.sendToolListChanged(),
      'stream',
    );
  }

  private deliverSchemaNotice(send: () => Promise<void>, via: string): void {
    if (!this.schemaNoticeDue || this.announcing) return;
    this.announcing = true;
    channelLog('session: tool list changed', 'id', this.id, 'via', via);
    send()
      .then(() => {
        this.issuedSchema = toolSchemaSignature();
        this.announcing = false;
      })
      .catch((err: unknown) => {
        this.announcing = false;
        channelLog('session: tool list changed notice failed', errMsg(err));
      });
  }

  dropStream(): void {
    const sink = this.sink;
    this.sink = undefined;
    sink?.close();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onClosed(this);
    forgetPromptsOf(this.server);
    this.dropStream();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.server.close().catch(() => undefined);
  }
}
