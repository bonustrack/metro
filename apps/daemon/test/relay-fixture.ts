import { InboundRelay } from '../src/channels/inbound.ts';

export interface Notif {
  method: string;
  params: { content?: string; meta?: Record<string, unknown>; [key: string]: unknown };
}

export interface FakeRelay {
  relay: InboundRelay;
  notifs: Notif[];
}

export function makeRelay(stations: string[], notify: (n: Notif) => Promise<void> = () => Promise.resolve()): FakeRelay {
  const notifs: Notif[] = [];
  const relay = new InboundRelay({
    mcp: {
      notification: (n: Notif) => {
        notifs.push(n);
        return notify(n);
      },
    } as never,
    log: () => undefined,
    getStations: () => new Set(stations),
    senderAllowed: () => true,
  });
  return { relay, notifs };
}

export const channelContents = (notifs: Notif[]): string[] =>
  notifs.filter((n) => n.method === 'notifications/claude/channel').map((n) => String(n.params.content));
