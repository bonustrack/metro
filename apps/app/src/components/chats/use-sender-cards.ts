import { fetchSenderCards, type SenderCard } from '@metro-labs/client/api/senders';
import { useBoxQuery } from '../../lib/queries.js';

export function useSenderCards(agentId: string, station: string, accountId: string, entries: string[]): SenderCard[] {
  const cards = useBoxQuery(['sender-cards', agentId, station, accountId, entries.join('\n')], () => fetchSenderCards(agentId, station, accountId), {
    enabled: entries.length > 0,
    staleTime: 600_000,
  });
  return cards.data ?? [];
}
