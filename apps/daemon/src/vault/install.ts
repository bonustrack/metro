import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSecureDir } from '@metro-labs/core/secure-fs';
import { binDir, caDir, PROXY_VERSION, proxyBin, vaultDir } from './paths.js';

const RELEASES = `https://github.com/ironsh/iron-proxy/releases/download/v${PROXY_VERSION}`;

export const archiveName = (arch = process.arch): string => `iron-proxy_${PROXY_VERSION}_linux_${arch === 'arm64' ? 'arm64' : 'amd64'}.tar.gz`;

export function expectedSum(checksums: string, file: string): string | null {
  const line = checksums.split('\n').find((l) => l.trim().endsWith(` ${file}`));
  const sum = line?.trim().split(/\s+/)[0];
  return sum !== undefined && /^[0-9a-f]{64}$/.test(sum) ? sum : null;
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${url} answered ${String(res.status)}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function ensureProxyBinary(dir = vaultDir()): Promise<string> {
  const bin = proxyBin(dir);
  if (existsSync(bin)) return bin;
  const file = archiveName();
  const [archive, checksums] = await Promise.all([download(`${RELEASES}/${file}`), download(`${RELEASES}/checksums.txt`)]);
  const want = expectedSum(checksums.toString('utf8'), file);
  const got = createHash('sha256').update(archive).digest('hex');
  if (want === null || want !== got) throw new Error(`the iron-proxy download does not match its checksum (${file})`);
  const work = mkdtempSync(join(tmpdir(), 'metro-iron-'));
  try {
    writeFileSync(join(work, file), archive);
    const untar = spawnSync('tar', ['-xzf', file, 'iron-proxy'], { cwd: work, encoding: 'utf8' });
    if (untar.status !== 0) throw new Error(`could not unpack iron-proxy: ${untar.stderr.trim()}`);
    ensureSecureDir(binDir(dir));
    copyFileSync(join(work, 'iron-proxy'), `${bin}.part`);
    chmodSync(`${bin}.part`, 0o755);
    renameSync(`${bin}.part`, bin);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return bin;
}

export function ensureAuthority(bin: string, dir = vaultDir()): string {
  const cert = join(caDir(dir), 'ca.crt');
  if (existsSync(cert) && existsSync(join(caDir(dir), 'ca.key'))) return cert;
  ensureSecureDir(caDir(dir));
  const made = spawnSync(bin, ['generate-ca', '-outdir', caDir(dir), '-name', 'Metro vault', '-expiry-hours', '87600', '-alg', 'rsa4096'], { encoding: 'utf8' });
  if (made.status !== 0) throw new Error(`could not create the vault certificate: ${made.stderr.trim()}`);
  chmodSync(join(caDir(dir), 'ca.key'), 0o600);
  return cert;
}
