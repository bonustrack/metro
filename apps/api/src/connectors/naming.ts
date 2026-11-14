import { accountConnectorName, productName } from '@metro-labs/core/connector-name';
import type { VerifiedServer } from '@metro-labs/http/connector-mcp';
import { plainAccount } from '@metro-labs/connectors/catalogue';
import { AUTO_NAMED, type ConnectorDetail, type ConnectorSecret } from '@metro-labs/connectors/model';

export function accountName(verified: VerifiedServer, secret: ConnectorSecret): string | null {
  const account = plainAccount(verified.account, secret);
  return account === null ? null : accountConnectorName(productName(verified, secret.targetUrl), account);
}

export const isAutoNamed = (detail: ConnectorDetail): boolean => detail.named === AUTO_NAMED;
