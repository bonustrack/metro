import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isRecord } from './background.js';
import { ISSUER, isVersion, PUBLISHER, RELEASE_DIR, type Published, type ReleaseDeps } from './root-release.js';
import { PACKAGE_NAME } from './version.js';

const REGISTRY = 'https://registry.npmjs.org';
const ENCODED = PACKAGE_NAME.replace('/', '%2F');
const ROOT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const SETUP = join('runtime', 'node_modules', '@metro-labs', 'daemon', 'src', 'metro-user', 'install.ts');
const MAX_TARBALL = 64 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

interface VerifyOptions {
  certificateIdentityURI: string;
  certificateIssuer: string;
  tufCachePath: string;
}

interface Sigstore {
  verify: (bundle: unknown, options: VerifyOptions) => Promise<unknown>;
}

const isSigstore = (mod: unknown): mod is Sigstore => isRecord(mod) && typeof mod.verify === 'function';

export function rootOwned(path: string): boolean {
  let at = realpathSync(path);
  for (;;) {
    const st = statSync(at);
    if (st.uid !== 0 || (st.mode & 0o022) !== 0) return false;
    if (at === dirname(at)) return true;
    at = dirname(at);
  }
}

function mustBeRootOwned(path: string, what: string): string {
  if (!existsSync(path) || !rootOwned(path)) throw new Error(`${what} at ${path} is missing or not owned by root alone; refused`);
  return path;
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} answered ${String(res.status)}`);
  return res.json();
}

async function published(version: string): Promise<Published> {
  const body = await getJson(`${REGISTRY}/${ENCODED}`);
  const tags = isRecord(body) && isRecord(body['dist-tags']) ? body['dist-tags'] : {};
  const entry = isRecord(body) && isRecord(body.versions) ? body.versions[version] : undefined;
  const dist = isRecord(entry) && isRecord(entry.dist) ? entry.dist : {};
  if (typeof dist.tarball !== 'string' || typeof dist.integrity !== 'string') throw new Error(`npm has no ${PACKAGE_NAME}@${version}`);
  return { tags, tarball: dist.tarball, integrity: dist.integrity };
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} answered ${String(res.status)}`);
  if (Number(res.headers.get('content-length') ?? 0) > MAX_TARBALL) throw new Error(`${url} is too large`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_TARBALL) throw new Error(`${url} is too large`);
  return bytes;
}

function loadSigstore(): Sigstore {
  const npm = mustBeRootOwned(join(dirname(dirname(process.execPath)), 'lib', 'node_modules', 'npm'), "npm's sigstore");
  const mod: unknown = createRequire(join(npm, 'package.json'))('sigstore');
  if (!isSigstore(mod)) throw new Error(`no sigstore verifier in ${npm}; refused`);
  return mod;
}

function leafCertificate(bundle: unknown): string | null {
  const material = isRecord(bundle) && isRecord(bundle.verificationMaterial) ? bundle.verificationMaterial : {};
  const chain = isRecord(material.x509CertificateChain) && Array.isArray(material.x509CertificateChain.certificates) ? (material.x509CertificateChain.certificates as unknown[]) : [];
  const leaf = isRecord(material.certificate) ? material.certificate : chain[0];
  return isRecord(leaf) && typeof leaf.rawBytes === 'string' ? leaf.rawBytes : null;
}

export function signedByPublisher(bundle: unknown): boolean {
  const raw = leafCertificate(bundle);
  if (raw === null) return false;
  const names = new X509Certificate(Buffer.from(raw, 'base64')).subjectAltName?.split(', ') ?? [];
  return names.includes(`URI:${PUBLISHER}`);
}

async function verifySignature(bundle: unknown): Promise<void> {
  if (!signedByPublisher(bundle)) throw new Error(`the provenance was not signed for ${PUBLISHER}; refused`);
  const sigstore = loadSigstore();
  const tuf = mkdtempSync(join(tmpdir(), 'metro-tuf-'));
  try {
    await sigstore.verify(bundle, { certificateIdentityURI: PUBLISHER, certificateIssuer: ISSUER, tufCachePath: tuf });
  } catch (err) {
    throw new Error(`the provenance signature does not check out: ${err instanceof Error ? err.message : String(err)}; refused`);
  } finally {
    rmSync(tuf, { recursive: true, force: true });
  }
}

function checked(file: string, args: string[], cwd = '/'): void {
  const run = spawnSync(file, args, { cwd, env: { PATH: ROOT_PATH }, stdio: ['ignore', 'inherit', 'inherit'] });
  if (run.error !== undefined) throw run.error;
  if (run.status !== 0) throw new Error(`${file} ${args.join(' ')} failed (exit ${String(run.status)})`);
}

function manifestVersion(dir: string): string | null {
  const file = join(dir, 'package.json');
  if (!existsSync(file)) return null;
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  return isRecord(raw) && raw.name === PACKAGE_NAME && typeof raw.version === 'string' && isVersion(raw.version) ? raw.version : null;
}

function unpack(tarball: Buffer, version: string): string {
  const work = mkdtempSync(join(tmpdir(), 'metro-release-'));
  const staged = `${RELEASE_DIR}.new`;
  try {
    const file = join(work, 'metro.tgz');
    writeFileSync(file, tarball, { mode: 0o600 });
    rmSync(staged, { recursive: true, force: true });
    mkdirSync(staged, { recursive: true, mode: 0o755 });
    checked('tar', ['-xzf', file, '-C', staged, '--strip-components=1', '--no-same-owner', '--no-same-permissions']);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (manifestVersion(staged) !== version) throw new Error(`the unpacked package is not ${PACKAGE_NAME}@${version}; refused`);
  return staged;
}

function findBun(): string {
  const found = ROOT_PATH.split(':')
    .map((dir) => join(dir, 'bun'))
    .find((path) => existsSync(path));
  if (found === undefined) throw new Error(`no bun on ${ROOT_PATH}`);
  return mustBeRootOwned(found, 'bun');
}

function setup(dir: string): void {
  const node = mustBeRootOwned(process.execPath, 'node');
  checked(findBun(), ['--no-install', join(dir, SETUP), '--node', node]);
}

function swap(staged: string): void {
  const old = `${RELEASE_DIR}.old`;
  rmSync(old, { recursive: true, force: true });
  if (existsSync(RELEASE_DIR)) renameSync(RELEASE_DIR, old);
  renameSync(staged, RELEASE_DIR);
  rmSync(old, { recursive: true, force: true });
}

export function realReleaseDeps(): ReleaseDeps {
  process.umask(0o022);
  mkdirSync(dirname(RELEASE_DIR), { recursive: true, mode: 0o755 });
  return {
    installed: () => manifestVersion(RELEASE_DIR),
    published,
    download,
    attestations: (version) => getJson(`${REGISTRY}/-/npm/v1/attestations/${ENCODED}@${version}`),
    verifySignature,
    unpack,
    setup,
    swap,
    out: (line) => {
      process.stderr.write(`metro root: ${line}\n`);
    },
  };
}
