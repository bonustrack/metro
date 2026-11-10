import { parsePublicConnectorUrl } from '@metro-labs/http/connector-public-url';
import { ConnectorUnauthorized } from '@metro-labs/http/connector-url';
import { connectorAuthOf } from '@metro-labs/connectors/catalogue';
import { catalogueCredential, catalogueSecret, catalogueSignin, type CatalogueDeps } from '@metro-labs/connectors/catalogue-auth';
import { credentialRevision } from '@metro-labs/connectors/revision';
import type { VendorTarget } from './credential.js';

export interface OrgCredentialDeps {
  key: Buffer;
  catalogue: CatalogueDeps;
  now: () => number;
}

async function orgTarget(deps: OrgCredentialDeps, owner: string, connector: string, forced?: string): Promise<VendorTarget> {
  const row = await catalogueCredential(deps.catalogue, owner, connector, forced);
  const secret = catalogueSecret(deps.key, row, deps.now());
  return { url: parsePublicConnectorUrl(secret.targetUrl), auth: connectorAuthOf(secret), secret, revision: credentialRevision(deps.key, row) };
}

export async function withOrgCredential<T>(deps: OrgCredentialDeps, owner: string, connector: string, work: (target: VendorTarget) => Promise<T>): Promise<T> {
  const first = await orgTarget(deps, owner, connector);
  try {
    return await work(first);
  } catch (err) {
    if (!(err instanceof ConnectorUnauthorized)) throw err;
  }
  if (first.secret.kind !== 'oauth') throw catalogueSignin();
  const second = await orgTarget(deps, owner, connector, first.revision);
  if (second.revision === first.revision) throw catalogueSignin();
  try {
    return await work(second);
  } catch (err) {
    if (err instanceof ConnectorUnauthorized) throw catalogueSignin();
    throw err;
  }
}
