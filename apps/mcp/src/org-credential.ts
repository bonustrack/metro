import { parsePublicConnectorUrl } from '@metro-labs/http/connector-public-url';
import { connectorAuthOf } from '@metro-labs/connectors/catalogue';
import { catalogueCredential, catalogueSecret, catalogueSignin, type CatalogueDeps } from '@metro-labs/connectors/catalogue-auth';
import { credentialRevision } from '@metro-labs/connectors/revision';
import { renewing, type VendorTarget } from './credential.js';

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

export const withOrgCredential = <T>(deps: OrgCredentialDeps, owner: string, connector: string, work: (target: VendorTarget) => Promise<T>): Promise<T> =>
  renewing((forced) => orgTarget(deps, owner, connector, forced), () => Promise.resolve(catalogueSignin()), work);
