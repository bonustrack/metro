import type {
  EventStore,
  EventId,
  StreamId,
} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { str } from '@metro-labs/core/str';
import { eventInScope } from '../agents/scope.js';

const EVENT_STORE_MAX = 500;

interface StoredEvent {
  eventId: EventId;
  streamId: StreamId;
  message: JSONRPCMessage;
  line: string | undefined;
}

export interface ScopedReplay {
  send: (eventId: EventId, message: JSONRPCMessage) => Promise<void>;
  scope: Set<string>;
  onWithheld?: (eventId: EventId, line: string | undefined) => void;
}

const SEP = '_';

function frameLine(message: JSONRPCMessage): string | undefined {
  const params: unknown = (message as { params?: unknown }).params;
  if (typeof params !== 'object' || params === null) return undefined;
  const meta: unknown = (params as { meta?: unknown }).meta;
  if (typeof meta !== 'object' || meta === null) return undefined;
  return str((meta as { line?: unknown }).line) || undefined;
}

const encodeEventId = (streamId: StreamId, seq: number): EventId =>
  `${streamId}${SEP}${seq}`;

const decodeStreamId = (eventId: EventId): StreamId | undefined => {
  const idx = eventId.lastIndexOf(SEP);
  if (idx <= 0) return undefined;
  return eventId.slice(0, idx);
};

export class BoundedEventStore implements EventStore {
  private readonly max: number;
  private readonly events: StoredEvent[] = [];
  private seq = 0;

  constructor(max = EVENT_STORE_MAX) {
    this.max = max;
  }

  storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    const eventId = encodeEventId(streamId, ++this.seq);
    this.events.push({
      eventId,
      streamId,
      message,
      line: frameLine(message),
    });
    if (this.events.length > this.max) this.events.shift();
    return Promise.resolve(eventId);
  }

  getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    return Promise.resolve(decodeStreamId(eventId));
  }

  async replayEventsAfter(
    lastEventId: EventId,
    { send, scope, onWithheld }: ScopedReplay,
  ): Promise<StreamId> {
    const streamId = decodeStreamId(lastEventId);
    if (streamId === undefined) return '';
    let seen = false;
    for (const e of this.events) {
      if (e.streamId !== streamId) continue;
      if (!seen) {
        if (e.eventId === lastEventId) seen = true;
        continue;
      }
      if (e.line !== undefined && !eventInScope(scope, e.line)) {
        onWithheld?.(e.eventId, e.line);
        continue;
      }
      await send(e.eventId, e.message);
    }
    return streamId;
  }
}
