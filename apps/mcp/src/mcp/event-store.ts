import type {
  EventStore,
  EventId,
  StreamId,
} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export const EVENT_STORE_MAX = 500;

interface StoredEvent {
  eventId: EventId;
  streamId: StreamId;
  message: JSONRPCMessage;
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
  private readonly events: StoredEvent[] = [];
  private seq = 0;

  constructor(max: number = EVENT_STORE_MAX) {
    this.max = max;
  }

  storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    const eventId = encodeEventId(streamId, ++this.seq);
    this.events.push({ eventId, streamId, message });
    if (this.events.length > this.max) this.events.shift();
    return Promise.resolve(eventId);
  }

  getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    return Promise.resolve(decodeStreamId(eventId));
  }

  async replayEventsAfter(
    lastEventId: EventId,
    { send }: { send: (id: EventId, message: JSONRPCMessage) => Promise<void> },
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
      await send(e.eventId, e.message);
    }
    return streamId;
  }
}
