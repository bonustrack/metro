export interface ConnectorSyncReceipt {
  state: 'waiting' | 'received' | 'expired' | 'unavailable';
  lastReceivedAt: number | null;
  leaseExpiresAt: number | null;
  counts: { total: number; ready: number; unavailable: number } | null;
}

export interface ConnectorSyncStatus extends Omit<ConnectorSyncReceipt, 'state'> {
  enabled: boolean;
  source: 'saved' | 'environment' | 'default' | 'invalid' | 'scope_changed';
  enrolled: boolean;
  owner: string | null;
  agentId: string | null;
  scope: string;
  liveEnabled: boolean;
  state: 'off' | 'not_enrolled' | ConnectorSyncReceipt['state'];
}
