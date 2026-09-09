import { isRecord } from '@metro-labs/core/is-record';
import { errMsg } from '@metro-labs/core/log';
import type { RelayTarget } from './relay-target.js';

const ACCEPT = 'application/json, text/event-stream';
const PROTOCOL = '2025-11-25';
const MAX_PAGES = 10;
const LIST_MS = 15_000;
const CALL_MS = 120_000;

export interface UpstreamTool {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations: unknown;
}

export type TargetOf = (force: boolean) => Promise<RelayTarget>;

export class UpstreamRefused extends Error {}
export class UpstreamFailed extends Error {}

interface Live {
  session: string | null;
  protocol: string;
}

interface Answer {
  status: number;
  text: string;
  contentType: string;
  session: string | null;
}

function dataLines(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
}

function messageFor(answer: Answer, id: number): Record<string, unknown> | null {
  const candidates = answer.contentType.includes('text/event-stream') ? dataLines(answer.text) : [answer.text];
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed) && parsed.id === id) return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

function resultOf(answer: Answer, id: number): unknown {
  const message = messageFor(answer, id);
  if (message === null) throw new UpstreamFailed('answered without a result for the request');
  if (isRecord(message.error)) {
    const text = typeof message.error.message === 'string' ? message.error.message : JSON.stringify(message.error);
    throw new UpstreamFailed(text);
  }
  return message.result;
}

const initializeBody = (id: number): unknown => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'metro', version: '0.1.0' } },
});

function toolOf(raw: unknown): UpstreamTool | null {
  if (!isRecord(raw) || typeof raw.name !== 'string' || raw.name === '') return null;
  return {
    name: raw.name,
    description: typeof raw.description === 'string' ? raw.description : '',
    inputSchema: isRecord(raw.inputSchema) ? raw.inputSchema : { type: 'object' },
    annotations: isRecord(raw.annotations) ? raw.annotations : undefined,
  };
}

export class UpstreamClient {
  private live: Live | null = null;
  private seq = 0;

  constructor(private readonly target: TargetOf) {}

  forget(): void {
    this.live = null;
  }

  async listTools(): Promise<UpstreamTool[]> {
    const tools: UpstreamTool[] = [];
    let cursor = '';
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.rpc('tools/list', cursor === '' ? {} : { cursor }, LIST_MS);
      if (!isRecord(result)) break;
      if (Array.isArray(result.tools)) for (const raw of result.tools) {
        const tool = toolOf(raw);
        if (tool !== null) tools.push(tool);
      }
      const next = result.nextCursor;
      if (typeof next !== 'string' || next === '' || next === cursor) break;
      cursor = next;
    }
    return tools;
  }

  callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.rpc('tools/call', { name, arguments: args }, CALL_MS);
  }

  private async post(body: unknown, headers: Record<string, string>, force: boolean, ms: number): Promise<Answer> {
    const target = await this.target(force);
    if (target.kind === 'missing') throw new UpstreamRefused('this connector no longer exists on the daemon');
    if (target.kind === 'signin') throw new UpstreamRefused('this connector needs signing in again on its page');
    let res: Response;
    try {
      res = await fetch(target.url, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(ms),
        headers: { 'content-type': 'application/json', accept: ACCEPT, ...target.headers, ...headers },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new UpstreamFailed(`could not be reached (${errMsg(err)})`);
    }
    const text = await res.text().catch(() => '');
    return { status: res.status, text, contentType: res.headers.get('content-type') ?? '', session: res.headers.get('mcp-session-id') };
  }

  private async withCredentialLadder(body: unknown, headers: Record<string, string>, ms: number): Promise<Answer> {
    const first = await this.post(body, headers, false, ms);
    if (first.status !== 401 && first.status !== 403) return first;
    const again = await this.post(body, headers, true, ms);
    if (again.status === 401 || again.status === 403) throw new UpstreamRefused('rejected the credential; sign in again on its page');
    return again;
  }

  private async ensureSession(): Promise<Live> {
    if (this.live !== null) return this.live;
    const id = ++this.seq;
    const answer = await this.withCredentialLadder(initializeBody(id), {}, LIST_MS);
    if (answer.status >= 300) throw new UpstreamFailed(`answered ${String(answer.status)} to initialize`);
    const result = resultOf(answer, id);
    const protocol = isRecord(result) && typeof result.protocolVersion === 'string' ? result.protocolVersion : PROTOCOL;
    this.live = { session: answer.session, protocol };
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, this.sessionHeaders(this.live), false, LIST_MS).catch(() => undefined);
    return this.live;
  }

  private sessionHeaders(live: Live): Record<string, string> {
    const headers: Record<string, string> = { 'mcp-protocol-version': live.protocol };
    if (live.session !== null && live.session !== '') headers['mcp-session-id'] = live.session;
    return headers;
  }

  private async rpc(method: string, params: unknown, ms: number): Promise<unknown> {
    const live = await this.ensureSession();
    const id = ++this.seq;
    const body = { jsonrpc: '2.0', id, method, params };
    let answer = await this.withCredentialLadder(body, this.sessionHeaders(live), ms);
    if (answer.status === 404 && live.session !== null) {
      this.live = null;
      answer = await this.withCredentialLadder(body, this.sessionHeaders(await this.ensureSession()), ms);
    }
    if (answer.status >= 300) throw new UpstreamFailed(`answered ${String(answer.status)}${answer.text === '' ? '' : `: ${answer.text.slice(0, 200)}`}`);
    return resultOf(answer, id);
  }
}
