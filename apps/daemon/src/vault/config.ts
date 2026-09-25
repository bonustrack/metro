import { caDir, ports, valueFile, vaultDir } from './paths.js';
import type { VaultSecret } from './store.js';
import { join } from 'node:path';

export const MANAGEMENT_KEY_ENV = 'IRON_MANAGEMENT_API_KEY';

function secretEntry(secret: VaultSecret, dir: string): Record<string, unknown> {
  return {
    source: { type: 'file', path: valueFile(secret.id, dir) },
    replace: { proxy_value: secret.env, match_headers: [], match_query: true },
    rules: secret.hosts.map((host) => ({ host })),
  };
}

export function proxyConfig(secrets: VaultSecret[], dir = vaultDir()): Record<string, unknown> {
  const p = ports();
  const local = (port: number): string => `127.0.0.1:${String(port)}`;
  return {
    dns: { enabled: false },
    proxy: {
      tunnel_listen: local(p.tunnel),
      http_listen: local(p.http),
      https_listen: local(p.https),
      upstream_response_header_timeout: '10m',
    },
    tls: { mode: 'mitm', ca_cert: join(caDir(dir), 'ca.crt'), ca_key: join(caDir(dir), 'ca.key') },
    transforms: secrets.length === 0 ? [] : [{ name: 'secrets', config: { secrets: secrets.map((s) => secretEntry(s, dir)) } }],
    metrics: { listen: local(p.metrics) },
    management: { listen: local(p.management), api_key_env: MANAGEMENT_KEY_ENV },
    log: { level: 'info' },
  };
}

export function proxyEnvFor(caFile: string, bundle: string, secrets: VaultSecret[]): Record<string, string> {
  const url = `http://127.0.0.1:${String(ports().tunnel)}`;
  const skip = 'localhost,127.0.0.1,::1';
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    NO_PROXY: skip,
    no_proxy: skip,
    NODE_EXTRA_CA_CERTS: caFile,
    SSL_CERT_FILE: bundle,
    REQUESTS_CA_BUNDLE: bundle,
    CURL_CA_BUNDLE: bundle,
    GIT_SSL_CAINFO: bundle,
    ...Object.fromEntries(secrets.map((s) => [s.env, s.env])),
  };
}
