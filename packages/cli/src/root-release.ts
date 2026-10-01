import { createHash } from 'node:crypto';
import { isRecord } from './background.js';
import { compareVersions, PACKAGE_NAME } from './version.js';

export const RELEASE_DIR = '/usr/local/lib/metro/release';
export const PUBLISHER = 'https://github.com/bonustrack/metro/.github/workflows/publish-cli.yml@refs/heads/main';
export const ISSUER = 'https://token.actions.githubusercontent.com';
const REGISTRY = 'https://registry.npmjs.org';
const PROVENANCE = 'https://slsa.dev/provenance/v1';
const IN_TOTO = 'application/vnd.in-toto+json';
const VERSION_RE = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z]{1,20}(?:\.[0-9A-Za-z]{1,20}){0,4})?$/;

export type Trigger = 'root' | 'metro';

export interface Published {
  tags: Record<string, unknown>;
  tarball: string;
  integrity: string;
}

export interface ReleaseDeps {
  installed: () => string | null;
  published: (version: string) => Promise<Published>;
  download: (url: string) => Promise<Buffer>;
  attestations: (version: string) => Promise<unknown>;
  verifySignature: (bundle: unknown) => Promise<void>;
  unpack: (tarball: Buffer, version: string) => string;
  setup: (dir: string) => void;
  swap: (staged: string) => void;
  out: (line: string) => void;
}

export const isVersion = (raw: string): boolean => VERSION_RE.test(raw);

export const tarballUrl = (version: string): string => `${REGISTRY}/${PACKAGE_NAME}/-/metro-${version}.tgz`;

const subjectName = (version: string): string => `pkg:npm/${PACKAGE_NAME.replace('@', '%40')}@${version}`;

function provenanceBundle(body: unknown, version: string): Record<string, unknown> {
  const list = isRecord(body) && Array.isArray(body.attestations) ? (body.attestations as unknown[]) : [];
  const entry = list.find((a) => isRecord(a) && a.predicateType === PROVENANCE);
  if (!isRecord(entry) || !isRecord(entry.bundle)) throw new Error(`${PACKAGE_NAME}@${version} has no build provenance on npm; refused`);
  return entry.bundle;
}

function statementOf(bundle: Record<string, unknown>): Record<string, unknown> {
  const envelope = bundle.dsseEnvelope;
  if (!isRecord(envelope) || envelope.payloadType !== IN_TOTO || typeof envelope.payload !== 'string')
    throw new Error('the provenance is not a signed in-toto statement; refused');
  const statement: unknown = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
  if (!isRecord(statement)) throw new Error('the provenance statement is unreadable; refused');
  return statement;
}

export function provenanceNames(statement: Record<string, unknown>, version: string, sha512: string): boolean {
  const subjects = Array.isArray(statement.subject) ? (statement.subject as unknown[]) : [];
  return (
    statement.predicateType === PROVENANCE &&
    subjects.some((s) => isRecord(s) && s.name === subjectName(version) && isRecord(s.digest) && s.digest.sha512 === sha512)
  );
}

async function checkProvenance(version: string, tarball: Buffer, deps: ReleaseDeps): Promise<void> {
  const bundle = provenanceBundle(await deps.attestations(version), version);
  await deps.verifySignature(bundle);
  const sha512 = createHash('sha512').update(tarball).digest('hex');
  if (!provenanceNames(statementOf(bundle), version, sha512))
    throw new Error(`the signed provenance does not name this tarball of ${PACKAGE_NAME}@${version}; refused`);
}

async function fetchChecked(version: string, trigger: Trigger, deps: ReleaseDeps): Promise<Buffer> {
  const published = await deps.published(version);
  if (trigger === 'metro' && published.tags.beta !== version && published.tags.latest !== version)
    throw new Error(`${version} is not what the beta or latest tag of ${PACKAGE_NAME} points to now; refused`);
  if (published.tarball !== tarballUrl(version)) throw new Error(`npm names an unexpected tarball for ${version}: ${published.tarball}; refused`);
  const tarball = await deps.download(published.tarball);
  if (`sha512-${createHash('sha512').update(tarball).digest('base64')}` !== published.integrity)
    throw new Error(`the tarball of ${version} does not match the sha512 npm publishes for it; refused`);
  await checkProvenance(version, tarball, deps);
  return tarball;
}

export async function installRelease(version: string, trigger: Trigger, deps: ReleaseDeps): Promise<'current' | 'refreshed' | 'installed'> {
  if (!isVersion(version)) throw new Error(`'${version}' is not a ${PACKAGE_NAME} version`);
  const have = deps.installed();
  if (have !== null && compareVersions(version, have) <= 0) {
    if (trigger === 'metro') {
      deps.out(`the root side is at ${have}, and ${version} is not newer: nothing to do`);
      return 'current';
    }
    deps.setup(RELEASE_DIR);
    deps.out(`the root side stays at ${have} (it never goes back) and its root setup ran again`);
    return 'refreshed';
  }
  deps.out(`checking ${PACKAGE_NAME}@${version} (npm sha512 and the GitHub provenance of ${PUBLISHER})`);
  const tarball = await fetchChecked(version, trigger, deps);
  const staged = deps.unpack(tarball, version);
  deps.setup(staged);
  deps.swap(staged);
  deps.out(`the root side is now ${PACKAGE_NAME}@${version}, verified, in ${RELEASE_DIR}`);
  return 'installed';
}
