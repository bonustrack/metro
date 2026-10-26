import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InboundRelay } from '../channels/inbound.js';
import { answerPrompt, forgetPromptsOf, promptLine } from '../approvals/pending.js';
import { noteOwnerLine } from '../approvals/owner-line.js';
import { ChannelRelay, type ReplayLedger } from '../channels/relay.js';
import { errMsg } from '@metro-labs/core/log';
import { allowlistForLine, mayApprove, senderPermitted } from '../agents/map.js';
import { accountStationNames, stationByName } from '../stations/registry.js';
import { eventInScope } from '../agents/scope.js';
import { MCP_INSTRUCTIONS } from './instructions.js';
import { BoundedEventStore } from './event-store.js';
import { registerPermissionRelay } from './permission-relay.js';
import { registerToolHandlers, toolSchemaSignature } from './tool-dispatch.js';
import { web, type RawGetSink } from './raw-get-stream.js';
import { sharedCalls } from '../voice/shared.js';
import { CALL_STATE } from '@metro-labs/core/call';
import { clientDiagnostic, diagnosticTag, type SessionDiagnostic } from './diagnostics.js';

export const channelLog = (...a: unknown[]): void => {
  console.error('[metro-mcp]', ...a);
};

const getStations = (): Set<string> => new Set(accountStationNames());

const senderAllowed = (from: string, line: string, verified?: boolean): boolean =>
  senderPermitted(allowlistForLine(line), from, verified);

const approves = (station: string): boolean => stationByName(station)?.approvals !== false;

const noteDirect = (line: string, from: string): void => {
  if (mayApprove(line, from)) noteOwnerLine(line, from);
};

async function answerPermission(requestId: string, behavior: 'allow' | 'deny', line: string, from: string): Promise<boolean> {
  if (promptLine(requestId) !== line || !mayApprove(line, from)) return false;
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
  live: () => boolean;
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
  readonly live: () => boolean;
  private sink: RawGetSink | undefined;
  private unsubscribe: (() => void) | undefined;
  private closed = false;
  private issuedSchema: string | undefined;
  private announcing = false;
  private readonly onClosed: (session: McpSession) => void;
  private readonly openedAt = new Date().toISOString();
  private clientInitializedAt: string | null = null;
  private lastStreamAttachedAt: string | null = null;
  private lastStreamDetachedAt: string | null = null;

  private constructor(init: SessionInit) {
    this.id = init.id;
    this.scope = init.scope;
    this.live = init.live;
    this.issuedSchema = init.adopted ? undefined : toolSchemaSignature();
    this.onClosed = init.onClosed;
    this.eventStore = new BoundedEventStore();
    this.transport = makeTransport(init.id, this.eventStore, init.adopted);
    this.server = new Server(
      { name: 'metro', version: '0.1.0' },
      { capabilities: { tools: { listChanged: true } }, instructions: MCP_INSTRUCTIONS },
    );
    this.server.oninitialized = (): void => {
      this.clientInitializedAt = new Date().toISOString();
    };
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
      noteDirect,
      answerPermission,
      callMeta: (event) => sharedCalls.bindChat(event, this.scope),
    });
    registerPermissionRelay({
      mcp: this.server,
      relay: this.relay,
      inScope: (line) => this.inScope(line),
      live: this.live,
      log: channelLog,
    });
    this.channel = new ChannelRelay({
      relay: this.relay,
      log: channelLog,
      inScope: (line) => this.live() && this.inScope(line),
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

  diagnostics(): SessionDiagnostic {
    return {
      tag: diagnosticTag(this.id),
      openedAt: this.openedAt,
      transportInitialized: web(this.transport)?._initialized === true,
      clientInitializedAt: this.clientInitializedAt,
      client: clientDiagnostic(this.server.getClientVersion()),
      subscribed: this.unsubscribe !== undefined,
      streamAttached: this.streamAttached,
      lastStreamAttachedAt: this.lastStreamAttachedAt,
      lastStreamDetachedAt: this.lastStreamDetachedAt,
      stream: this.sink?.diagnostics() ?? null,
    };
  }

  inScope(line: string): boolean {
    return this.streamAttached && eventInScope(this.scope, line);
  }

  startChannel(): void {
    this.unsubscribe ??= this.channel.start();
  }

  stopChannel(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  replayMissed(): void {
    if (this.live()) this.channel.replayMissed();
  }

  bindSink(sink: RawGetSink | undefined): void {
    if (this.closed) {
      sink?.close();
      return;
    }
    if (sink === undefined && this.sink !== undefined) this.lastStreamDetachedAt = new Date().toISOString();
    this.sink = sink;
    if (sink !== undefined) {
      this.lastStreamAttachedAt = new Date().toISOString();
      this.announceCallState();
      this.toolsChanged();
    }
  }

  private announceCallState(): void {
    if (!this.streamAttached || this.server.getClientVersion()?.name !== 'metro-sdk-runner') return;
    const active = sharedCalls.snapshot();
    const route = active !== null && this.scope.has(active.agentId) && eventInScope(this.scope, active.line) ? active : null;
    this.server.notification({ method: CALL_STATE, params: { route, ...(route === null ? {} : { meta: { line: route.line } }) } }).catch((err: unknown) => {
      channelLog('session: call state notification failed', errMsg(err));
      if (route !== null) sharedCalls.end(route);
    });
  }

  private get schemaNoticeDue(): boolean {
    return this.issuedSchema !== toolSchemaSignature();
  }

  toolsChanged(): void {
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
    if (sink !== undefined) this.lastStreamDetachedAt = new Date().toISOString();
    this.sink = undefined;
    sink?.close();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    sharedCalls.revoke();
    this.onClosed(this);
    forgetPromptsOf(this.server);
    this.dropStream();
    this.stopChannel();
    await this.server.close().catch(() => undefined);
  }
}
