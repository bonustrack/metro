import { writeFileSync } from 'node:fs';
import { fakeIssuer, sessionClaims } from '../../packages/http/test/workos-fixture.ts';

const [out, org] = process.argv.slice(2);
if (out === undefined || org === undefined) throw new Error('usage: issuer.ts <out.json> <org id>');

const issuer = await fakeIssuer();
const now = Math.floor(Date.now() / 1000);
const token = issuer.mint(sessionClaims({ org_id: org, iat: now, exp: now + 3600 }));
const base = issuer.url.slice(0, issuer.url.indexOf('/sso/'));
writeFileSync(out, JSON.stringify({ base, token }));

const stop = (): void => {
  issuer.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
