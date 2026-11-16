import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { errMsg } from '@metro-labs/core/log';
import { MCP_INSTRUCTIONS } from './instructions.js';
import { registerToolHandlers } from './tool-dispatch.js';
import { channelLog, sessionTransport } from './session.js';

export const SIDE_MAX = 8;
export const SIDE_IDLE_MS = 10 * 60_000;

interface Side {
  server: Server;
  transport: StreamableHTTPServerTransport;
  usedAt: number;
}

export class SideSessions {
  private readonly open = new Map<string, Side>();
  private readonly starting = new Map<string, Promise<StreamableHTTPServerTransport>>();

  constructor(
    private readonly onSent: (messageId: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.open.size;
  }

  find(id: string): StreamableHTTPServerTransport | undefined {
    this.sweep();
    const side = this.open.get(id);
    if (side === undefined) return undefined;
    side.usedAt = this.now();
    return side.transport;
  }

  start(adoptId?: string): Promise<StreamableHTTPServerTransport> {
    if (adoptId !== undefined) {
      const pending = this.starting.get(adoptId);
      if (pending !== undefined) return pending;
    }
    const id = adoptId ?? randomUUID();
    const started = this.create(id, adoptId !== undefined).finally(() => {
      this.starting.delete(id);
    });
    this.starting.set(id, started);
    return started;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.open.keys()].map((id) => this.drop(id)));
  }

  private async create(id: string, adopted: boolean): Promise<StreamableHTTPServerTransport> {
    this.sweep();
    await Promise.all(this.leastRecent(this.open.size - SIDE_MAX + 1).map((old) => this.drop(old)));
    const server = new Server({ name: 'metro', version: '0.1.0' }, { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS });
    registerToolHandlers(server, undefined, { onSent: this.onSent });
    const transport = sessionTransport(id, undefined, adopted);
    await server.connect(transport);
    server.onclose = (): void => {
      if (this.open.get(id)?.server === server) this.open.delete(id);
    };
    this.open.set(id, { server, transport, usedAt: this.now() });
    channelLog('session: side session opened, the agent session is kept', 'id', id, 'adopted', adopted, 'open', this.open.size);
    return transport;
  }

  private leastRecent(count: number): string[] {
    if (count <= 0) return [];
    return [...this.open].sort((a, b) => a[1].usedAt - b[1].usedAt).slice(0, count).map(([id]) => id);
  }

  private sweep(): void {
    const cutoff = this.now() - SIDE_IDLE_MS;
    for (const [id, side] of this.open) {
      if (side.usedAt < cutoff) {
        this.drop(id).catch((err: unknown) => {
          channelLog('session: closing an idle side session failed', errMsg(err));
        });
      }
    }
  }

  private async drop(id: string): Promise<void> {
    const side = this.open.get(id);
    if (side === undefined) return;
    this.open.delete(id);
    await side.server.close().catch((err: unknown) => {
      channelLog('session: closing a side session failed', errMsg(err));
    });
  }
}
