import { errMsg, log } from '@metro-labs/core/log';
import { MCP_SETTLED_MAX, type McpConnectorEvent, type McpEventOutcome, type McpSettled } from '@metro-labs/http/mcp-server-protocol';

export type TakeEvent = (event: McpConnectorEvent) => McpEventOutcome | null;

const TAKEN_MAX = 2_000;

export class EventIntake {
  private readonly taken = new Map<string, McpEventOutcome>();
  private readonly unsent = new Map<string, McpEventOutcome>();

  constructor(private readonly take: TakeEvent) {}

  receive(events: McpConnectorEvent[]): number {
    let count = 0;
    for (const event of events) {
      const outcome = this.taken.get(event.id) ?? this.tryTake(event);
      if (outcome === null) continue;
      this.remember(event.id, outcome);
      this.unsent.set(event.id, outcome);
      count += 1;
    }
    return count;
  }

  settled(): McpSettled[] {
    return [...this.unsent].slice(0, MCP_SETTLED_MAX).map(([id, outcome]) => ({ id, outcome }));
  }

  sent(batch: McpSettled[]): void {
    for (const entry of batch) if (this.unsent.get(entry.id) === entry.outcome) this.unsent.delete(entry.id);
  }

  private tryTake(event: McpConnectorEvent): McpEventOutcome | null {
    try {
      return this.take(event);
    } catch (err) {
      log.warn({ event: event.id, err: errMsg(err) }, 'mcp-server: a connector event could not be handed to the session; it comes again');
      return null;
    }
  }

  private remember(id: string, outcome: McpEventOutcome): void {
    this.taken.delete(id);
    this.taken.set(id, outcome);
    for (const oldest of this.taken.keys()) {
      if (this.taken.size <= TAKEN_MAX) break;
      this.taken.delete(oldest);
    }
  }
}
