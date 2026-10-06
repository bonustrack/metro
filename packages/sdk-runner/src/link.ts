import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, type CallToolRequest, type CallToolResult, type ListToolsResult, type Notification } from '@modelcontextprotocol/sdk/types.js';
import { errMsg, log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { CALL_NOTICE, CALL_STATE, callNotice, callState, type CallNotice, type CallSource, type CallState } from '@metro-labs/core/call';
import { channelEvent, type ChannelEvent } from './channel-text.js';

const CHANNEL = 'notifications/claude/channel';
const ASK = 'notifications/claude/channel/permission_request';
const ANSWER = 'notifications/claude/channel/permission';
const TOOLS_CHANGED = 'notifications/tools/list_changed';
const MODEL = 'notifications/metro/model';
const TOOL_TIMEOUT_MS = 30 * 60_000;
const RECONNECT = { initialReconnectionDelay: 500, maxReconnectionDelay: 5_000, reconnectionDelayGrowFactor: 1.5, maxRetries: 60 };
const GAVE_UP = 'Maximum reconnection attempts';

export type Behavior = 'allow' | 'deny';

const modelIn = (params: Record<string, unknown>): string | null => (typeof params.model === 'string' && params.model !== '' ? params.model : null);

export interface PermissionAsk {
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
  call?: CallSource;
}

export interface LinkEvents {
  channel(event: ChannelEvent): void;
  call?(notice: CallNotice): void;
  callState?(state: CallState): void;
  toolsChanged(): void;
  model(model: string | null): void;
  lost(reason: string): void;
}

export interface Asker {
  ask(ask: PermissionAsk, signal: AbortSignal): Promise<Behavior>;
}

export class MetroLink implements Asker {
  private readonly waiting = new Map<string, (behavior: Behavior) => void>();

  private constructor(
    private readonly client: Client,
    private readonly events: LinkEvents,
  ) {}

  static async open(url: string, key: string, events: LinkEvents): Promise<MetroLink> {
    const client = new Client({ name: 'metro-sdk-runner', version: '0.1.0' });
    const link = new MetroLink(client, events);
    client.fallbackNotificationHandler = (notification): Promise<void> => {
      link.notified(notification);
      return Promise.resolve();
    };
    client.onerror = (err): void => {
      link.failed(err);
    };
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
      reconnectionOptions: RECONNECT,
    });
    await client.connect(transport);
    return link;
  }

  get instructions(): string | undefined {
    return this.client.getInstructions();
  }

  listTools(): Promise<ListToolsResult> {
    return this.client.listTools();
  }

  callTool(params: CallToolRequest['params'], signal: AbortSignal): Promise<CallToolResult> {
    return this.client.request({ method: 'tools/call', params }, CallToolResultSchema, {
      signal,
      timeout: TOOL_TIMEOUT_MS,
      resetTimeoutOnProgress: true,
    });
  }

  ask(ask: PermissionAsk, signal: AbortSignal): Promise<Behavior> {
    if (signal.aborted) return Promise.resolve('deny');
    return new Promise((resolve) => {
      const abort = (): void => {
        settle('deny');
        this.client.notification({ method: 'notifications/metro/permission_cancel', params: { request_id: ask.request_id } }).catch(() => {
          log.warn('sdk-runner: could not cancel a pending approval with metro');
        });
      };
      const settle = (behavior: Behavior): void => {
        signal.removeEventListener('abort', abort);
        if (!this.waiting.delete(ask.request_id)) return;
        resolve(behavior);
      };
      this.waiting.set(ask.request_id, settle);
      signal.addEventListener('abort', abort, { once: true });
      this.client.notification({ method: ASK, params: { ...ask } }).catch((err: unknown) => {
        log.warn({ err: errMsg(err), id: ask.request_id }, 'sdk-runner: could not hand an approval to metro');
        settle('deny');
      });
    });
  }

  async close(): Promise<void> {
    for (const settle of [...this.waiting.values()]) settle('deny');
    await this.client.close();
  }

  private notified(notification: Notification): void {
    const params = isRecord(notification.params) ? notification.params : {};
    if (notification.method === CHANNEL) {
      const event = channelEvent(params);
      if (event !== null) this.events.channel(event);
    } else if (notification.method === CALL_NOTICE) {
      this.callNotified(params);
    } else if (notification.method === CALL_STATE) {
      this.reconciled(params);
    } else if (notification.method === ANSWER) {
      this.answered(params);
    } else if (notification.method === TOOLS_CHANGED) {
      this.events.toolsChanged();
    } else if (notification.method === MODEL) {
      this.events.model(modelIn(params));
    }
  }

  private callNotified(params: Record<string, unknown>): void {
    const notice = callNotice(params);
    if (notice !== null) this.events.call?.(notice);
  }

  private reconciled(params: Record<string, unknown>): void {
    const state = callState(params);
    if (state !== null) this.events.callState?.(state);
  }

  private answered(params: Record<string, unknown>): void {
    const id = typeof params.request_id === 'string' ? params.request_id : '';
    this.waiting.get(id)?.(params.behavior === 'allow' ? 'allow' : 'deny');
  }

  private failed(err: Error): void {
    const reason = errMsg(err);
    if (reason.includes(GAVE_UP)) {
      this.events.lost(reason);
      return;
    }
    log.debug({ err: reason }, 'sdk-runner: the metro link reported an error');
  }
}
