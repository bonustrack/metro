import type { ModelConnectionRow } from '@metro-labs/connectors/db/models';
import { accountOf, type AccountView } from '@metro-labs/connectors/model-agent';
import type { ModelRoute } from '@metro-labs/connectors/model-route';
import { modelDetailOf } from '@metro-labs/connectors/model-secret';

export interface ConnectionView {
  id: string;
  provider: string;
  label: string;
  model: string;
  region: string;
  zdr: boolean;
  account: AccountView;
  subscription: boolean;
  signedOut: boolean;
  createdAt: string;
}

export interface ModelsView {
  connections: ConnectionView[];
  default: ModelRoute | null;
  agents: Record<string, ModelRoute>;
}

export function connectionView(row: ModelConnectionRow): ConnectionView {
  const detail = modelDetailOf(row.detail);
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    model: row.model,
    region: row.region,
    zdr: row.zdr,
    account: accountOf(detail),
    subscription: detail.subscription === true,
    signedOut: detail.signedOut === true || row.secret === null,
    createdAt: row.createdAt,
  };
}
