import type {
  EventStore,
  EventId,
  StreamId,
} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { frameInScope, frameLine } from './frame-scope.js';

const EVENT_STORE_MAX = 500;

interface StoredEvent {
  eventId: EventId;
  streamId: StreamId;
  message: JSONRPCMessage;
  line: string | undefined;
  owner: Set<string>;
}

export interface EventStoreDeps {
  scopeOf: () => Set<string>;
  max?: number;
}

export interface ScopedReplay {
  send: (eventId: EventId, message: JSONRPCMessage) => Promise<void>;
  scope: Set<string> | undefined;
  onWithheld?: (eventId: EventId, line: string | undefined) => void;
}

const SEP = '_';

const encodeEventId = (streamId: StreamId, seq: number): EventId =>
  `${streamId}${SEP}${seq}`;

const decodeStreamId = (eventId: EventId): StreamId | undefined => {
  const idx = eventId.lastIndexOf(SEP);
  if (idx <= 0) return undefined;
  return eventId.slice(0, idx);
};

export class BoundedEventStore implements EventStore {
  private readonly max: number;
  private readonly scopeOf: () => Set<string>;
  private readonly events: StoredEvent[] = [];
  private seq = 0;

  constructor(deps: EventStoreDeps) {
    this.scopeOf = deps.scopeOf;
    this.max = deps.max ?? EVENT_STORE_MAX;
  }

  storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    const eventId = encodeEventId(streamId, ++this.seq);
    this.events.push({
      eventId,
      streamId,
      message,
      line: frameLine(message),
      owner: new Set(this.scopeOf()),
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
    const allowed = scope ?? new Set<string>();
    let seen = false;
    for (const e of this.events) {
      if (e.streamId !== streamId) continue;
      if (!seen) {
        if (e.eventId === lastEventId) seen = true;
        continue;
      }
      if (!frameInScope(allowed, e)) {
        onWithheld?.(e.eventId, e.line);
        continue;
      }
      await send(e.eventId, e.message);
    }
    return streamId;
  }
}
