import { request } from 'node:http';
import { AwsError } from './ec2.js';

export const FLY_API_SOCKET = '/.fly/api';
export const STS_AUDIENCE = 'sts.amazonaws.com';

const TIMEOUT_MS = 5_000;
const JWT_RE = /^[\w-]+\.[\w-]+\.[\w-]+$/;
const ACTION = 'sts:AssumeRoleWithWebIdentity';

const refused = (why: string): AwsError => new AwsError('NoFlyToken', `Fly did not give Metro a sign-in token for AWS: ${why}`, ACTION);

export function flyOidcToken(audience: string, socketPath = FLY_API_SOCKET): Promise<string> {
  const body = JSON.stringify({ aud: audience });
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath, path: '/v1/tokens/oidc', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: TIMEOUT_MS },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (part: Buffer) => parts.push(part));
        res.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8').trim();
          if (res.statusCode !== 200) reject(refused(`the machine API answered ${String(res.statusCode)} ${text.slice(0, 200)}`));
          else if (!JWT_RE.test(text)) reject(refused('the machine API answered something that is not a token.'));
          else resolve(text);
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(refused(`the machine API did not answer within ${String(TIMEOUT_MS / 1000)} s.`));
    });
    req.on('error', (err) => {
      reject(err instanceof AwsError ? err : refused(`${err.message}. Metro gets one only when it runs on Fly.`));
    });
    req.end(body);
  });
}
