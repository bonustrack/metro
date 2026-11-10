import { createServer, type Server } from 'node:http';
import { randomInt, randomUUID } from 'node:crypto';
import { publishEvent, type MetroEvent } from '@metro-labs/core/events';
import { asLine, Line } from '@metro-labs/core/lines';
import { createMetroMcp } from '../src/mcp/index.ts';
import { forgetChannelAsks } from '../src/mcp/channel-asks.ts';
import { setKeyMap } from '../src/agents/keys.ts';
import { setAgentMap, setAllowlistMap, setApproversMap, setDisabledAccounts } from '../src/agents/map.ts';
import { setTrainCallBackend } from '../src/stations/train-call.ts';
import { forgetAllPrompts } from '../src/approvals/pending.ts';
import { forgetOwnerLine } from '../src/approvals/owner-line.ts';
import { setPolicies } from '../src/policy/policy.ts';
import { makeEmit } from '../src/routes/http.ts';
import { bootDaemon, type Daemon } from './http-harness.ts';
import { approvalIdIn } from './approval-id.ts';
import { auth, TEST_OWNER } from './identity-helper.ts';
import { openGet, type GetStream } from './mcp-probe.ts';
import { waitFor } from './wait.ts';

export const AGENT = 'agent000001';
export const TG = 'tb000000001';
export const GM = 'gm000000001';
export const LINE = `metro://telegram-bot/${TG}/-100777`;
export const OTHER_LINE = `metro://telegram-bot/${TG}/-100888`;
export const MAIL_LINE = `metro://gmail/${GM}/thread1`;
export const OWNER = `metro://telegram-bot/${TG}/user/111`;
export const MEMBER = `metro://telegram-bot/${TG}/user/222`;
export const STRANGER = `metro://telegram-bot/${TG}/user/999`;
export const MAIL_OWNER = `metro://gmail/${GM}/user/owner@example.com`;
export const TARGET = { kind: 'channel', station: 'telegram-bot', account: TG } as const;
export const MAIL_TARGET = { kind: 'channel', station: 'gmail', account: GM } as const;

export interface TrainCall {
  train: string;
  action: string;
  args: Record<string, unknown>;
}

export interface ToolAnswer {
  text: string;
  isError: boolean;
}

export interface PageAnswer {
  status: number;
  body: Record<string, unknown>;
}

export interface PageApproval {
  id: string;
  tool: string;
  description: string;
  preview: string;
  line: string | null;
  requestedAt: string;
}

interface ChatOptions {
  verified?: boolean;
  station?: string;
}

export const idIn = (answer: ToolAnswer): string => approvalIdIn(answer.text);

export class AsksHarness {
  calls: TrainCall[] = [];
  private server: Server | undefined;
  private page: Daemon | undefined;
  private stream: GetStream | undefined;
  private url = '';
  private sessionId = '';
  private handler: Awaited<ReturnType<typeof createMetroMcp>> | undefined;

  constructor(private readonly token: string) {}

  async start(): Promise<void> {
    forgetAllPrompts();
    forgetChannelAsks();
    forgetOwnerLine();
    setKeyMap([{ key: this.token, agentId: AGENT }]);
    setAgentMap({ [`telegram-bot/${TG}`]: AGENT, [`gmail/${GM}`]: AGENT }, { [AGENT]: 'Andy' });
    setAllowlistMap({ [`telegram-bot/${TG}`]: ['111', '222'], [`gmail/${GM}`]: ['owner@example.com'] });
    setApproversMap({ [`telegram-bot/${TG}`]: ['111'], [`gmail/${GM}`]: ['owner@example.com'] });
    const handler = await createMetroMcp({ publish: makeEmit() });
    this.handler = handler;
    handler.startInbound();
    const server = createServer((req, res) => {
      handler.httpHandler(req, res).catch(() => undefined);
    });
    this.server = server;
    const port = randomInt(10000, 30000);
    await new Promise<void>((done) => server.listen(port, '127.0.0.1', () => done()));
    this.url = `http://127.0.0.1:${String(port)}/mcp?token=${this.token}`;
    this.page = await bootDaemon({});
    await this.initialize();
  }

  async initialize(client = 'probe'): Promise<void> {
    await this.stream?.stop();
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: client, version: '0.0.0' } } }),
    });
    const sessionId = res.headers.get('mcp-session-id');
    await res.body?.cancel();
    if (!sessionId) throw new Error('no session id from initialize');
    this.sessionId = sessionId;
    await this.notify('notifications/initialized', {});
    this.stream = await openGet(this.url, this.sessionId);
    const hello = `hello agent ${randomUUID()}`;
    this.chat(LINE, OWNER, hello);
    await waitFor(() => this.raw().includes(hello));
  }

  reset(): void {
    this.calls = [];
    forgetAllPrompts();
    forgetChannelAsks();
    setDisabledAccounts(new Set());
    setPolicies('channel', [[TARGET, { write: 'ask' }]]);
    setTrainCallBackend((train, action, args) => {
      this.calls.push({ train, action, args: args as Record<string, unknown> });
      return Promise.resolve({ result: { messageId: `m-${String(this.calls.length)}` } });
    });
  }

  async stop(): Promise<void> {
    await this.stream?.stop();
    await this.page?.close();
    const server = this.server;
    if (server !== undefined) await new Promise<void>((done) => server.close(() => done()));
    setKeyMap([]);
    setAgentMap({}, {});
    setAllowlistMap({});
    setApproversMap({});
    setDisabledAccounts(new Set());
    setPolicies('channel', []);
    forgetAllPrompts();
    forgetChannelAsks();
    forgetOwnerLine();
  }

  raw(): string {
    return this.stream?.raw() ?? '';
  }

  setLive(on: boolean): void {
    this.handler?.setLiveEvents(on);
  }

  chat(line: string, from: string, text: string, options: ChatOptions = {}): void {
    publishEvent({
      id: `ev-${randomUUID()}`,
      ts: new Date().toISOString(),
      station: Line.station(line) ?? '',
      line: asLine(line),
      from: asLine(from),
      to: asLine(line),
      text,
      messageId: `mm-${randomUUID()}`,
      event: { type: 'msg' },
      ...(options.verified === undefined ? {} : { senderVerified: options.verified }),
    } as unknown as MetroEvent);
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': this.sessionId,
      'mcp-protocol-version': '2025-06-18',
    };
  }

  async rpc(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch(this.url, { method: 'POST', headers: this.headers(), body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) });
    const raw = await res.text();
    const json = raw.trimStart().startsWith('{') ? raw : (raw.split('\n').find((line) => line.startsWith('data: ')) ?? '').slice(6);
    return (JSON.parse(json) as { result: Record<string, unknown> }).result;
  }

  async notify(method: string, params: Record<string, unknown>): Promise<void> {
    const res = await fetch(this.url, { method: 'POST', headers: this.headers(), body: JSON.stringify({ jsonrpc: '2.0', method, params }) });
    await res.body?.cancel();
  }

  async tool(name: string, args: Record<string, unknown>): Promise<ToolAnswer> {
    const result = await this.rpc('tools/call', { name, arguments: args });
    const content = result.content as { text: string }[];
    return { text: content.map((part) => part.text).join('\n'), isError: result.isError === true };
  }

  send(args: Record<string, unknown>): Promise<ToolAnswer> {
    return this.tool('send', args);
  }

  sends(): TrainCall[] {
    return this.calls.filter((call) => call.action === 'send');
  }

  posted(text: string): TrainCall[] {
    return this.sends().filter((call) => call.args.text === text);
  }

  questions(): TrainCall[] {
    return this.sends().filter((call) => String(call.args.text).startsWith('Approval needed:'));
  }

  async pageCall(method: string, path = '', body?: unknown): Promise<PageAnswer> {
    if (this.page === undefined) throw new Error('no page daemon');
    const res = await fetch(`${this.page.base}/api/approvals${path}`, {
      method,
      headers: { authorization: await auth(TEST_OWNER, 'member'), 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  async listed(): Promise<PageApproval[]> {
    return (await this.pageCall('GET')).body.approvals as PageApproval[];
  }

  async answerOnPage(id: string, decision: 'allow' | 'deny'): Promise<number> {
    return (await this.pageCall('POST', `/${id}`, { decision })).status;
  }

  async told(text: string): Promise<boolean> {
    await waitFor(() => this.raw().includes(text));
    return this.raw().includes(text);
  }
}
