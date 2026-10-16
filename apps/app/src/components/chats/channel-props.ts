import { type FlatAccount } from '@metro-labs/client/api/accounts';
import { type StationsView } from '@metro-labs/client/api/client';

export interface ChannelProps {
  project: string;
  agentId: string;
  found: FlatAccount;
  view: StationsView;
  onSaved: () => Promise<unknown>;
}
