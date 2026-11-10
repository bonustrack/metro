import type { ConnectorRow } from '@metro-labs/connectors/db/connectors';
import type { SubscriptionRow } from '@metro-labs/connectors/db/connector-subscriptions';
import { detailOf } from '@metro-labs/connectors/model';
import { openSecret } from '@metro-labs/connectors/secrets';

const SIGNED_OUT = 'signed-out ';

export const SIGNED_OUT_NOTE = 'The mailbox is signed out on the connector, so Metro subscribes again after a new sign-in.';

export function signedInOf(connector: ConnectorRow): string {
  const detail = detailOf(connector.detail);
  return [connector.authGeneration ?? '', detail.signedInAt ?? '', detail.verifiedAt ?? ''].join(' ');
}

export const signedOutOf = (signedIn: string): string => `${SIGNED_OUT}${signedIn}`;

export function webhookSecretOf(key: Buffer, row: Pick<SubscriptionRow, 'owner' | 'id' | 'secret'>): string {
  const value = openSecret(key, row.owner, row.id, row.secret, 'webhook');
  if (typeof value !== 'string') throw new Error('The webhook secret could not be read.');
  return value;
}
