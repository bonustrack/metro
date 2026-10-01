import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { installRelease, RELEASE_DIR, tarballUrl, type ReleaseDeps } from '../src/root-release.ts';
import { rootOwned, signedByPublisher } from '../src/root-release-io.ts';
import { PUBLISH_CERT } from './provenance-fixture.ts';

const V = '0.1.0-beta.248';
const TARBALL = Buffer.from('the published tarball');
const HEX = createHash('sha512').update(TARBALL).digest('hex');
const INTEGRITY = `sha512-${createHash('sha512').update(TARBALL).digest('base64')}`;
const PROVENANCE = 'https://slsa.dev/provenance/v1';

const statement = (version = V, sha512 = HEX): Record<string, unknown> => ({
  _type: 'https://in-toto.io/Statement/v1',
  subject: [{ name: `pkg:npm/%40stage-labs/metro@${version}`, digest: { sha512 } }],
  predicateType: PROVENANCE,
  predicate: {},
});

const attestations = (st: Record<string, unknown> = statement(), payloadType = 'application/vnd.in-toto+json'): unknown => ({
  attestations: [
    { predicateType: 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1', bundle: { dsseEnvelope: { payloadType, payload: '' } } },
    { predicateType: PROVENANCE, bundle: { dsseEnvelope: { payloadType, payload: Buffer.from(JSON.stringify(st)).toString('base64'), signatures: [] } } },
  ],
});

interface Fake {
  deps: ReleaseDeps;
  calls: string[];
}

function fake(have: string | null, over: Partial<ReleaseDeps> = {}): Fake {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      installed: () => have,
      published: (version) => {
        calls.push(`published ${version}`);
        return Promise.resolve({ tags: { latest: '0.1.0-beta.0', beta: V }, tarball: tarballUrl(version), integrity: INTEGRITY });
      },
      download: (url) => {
        calls.push(`download ${url}`);
        return Promise.resolve(TARBALL);
      },
      attestations: (version) => {
        calls.push(`attestations ${version}`);
        return Promise.resolve(attestations());
      },
      verifySignature: () => {
        calls.push('verify');
        return Promise.resolve();
      },
      unpack: (_tarball, version) => {
        calls.push(`unpack ${version}`);
        return `${RELEASE_DIR}.new`;
      },
      setup: (dir) => {
        calls.push(`setup ${dir}`);
      },
      swap: (dir) => {
        calls.push(`swap ${dir}`);
      },
      out: () => undefined,
      ...over,
    },
  };
}

describe('the root side installs only a newer, published, signed Metro', () => {
  test('a newer version on the beta tag is downloaded, checked, unpacked, set up and only then put in place', async () => {
    const f = fake('0.1.0-beta.247');
    expect(await installRelease(V, 'metro', f.deps)).toBe('installed');
    expect(f.calls).toEqual([
      `published ${V}`,
      `download https://registry.npmjs.org/@stage-labs/metro/-/metro-${V}.tgz`,
      `attestations ${V}`,
      'verify',
      `unpack ${V}`,
      `setup ${RELEASE_DIR}.new`,
      `swap ${RELEASE_DIR}.new`,
    ]);
  });

  test('metro cannot ask for the same or an older version: nothing is fetched or run', async () => {
    for (const asked of [V, '0.1.0-beta.200', '0.0.9']) {
      const f = fake(V);
      expect(await installRelease(asked, 'metro', f.deps)).toBe('current');
      expect(f.calls).toEqual([]);
    }
  });

  test('root asking for the same or an older version only runs the root copy\'s setup again', async () => {
    const f = fake(V);
    expect(await installRelease('0.1.0-beta.240', 'root', f.deps)).toBe('refreshed');
    expect(f.calls).toEqual([`setup ${RELEASE_DIR}`]);
  });

  test('metro may only ask for what the beta or latest tag points to now; root may install its own version', async () => {
    const off = fake('0.1.0-beta.247', {
      published: (version) => Promise.resolve({ tags: { latest: '0.1.0-beta.0', beta: '0.1.0-beta.249' }, tarball: tarballUrl(version), integrity: INTEGRITY }),
    });
    await expect(installRelease(V, 'metro', off.deps)).rejects.toThrow(/not what the beta or latest tag/);
    expect(off.calls).toEqual([]);
    const latest = fake(null, {
      published: (version) => Promise.resolve({ tags: { latest: V, beta: '0.1.0-beta.249' }, tarball: tarballUrl(version), integrity: INTEGRITY }),
    });
    expect(await installRelease(V, 'metro', latest.deps)).toBe('installed');
    const root = fake(null, { published: off.deps.published });
    expect(await installRelease(V, 'root', root.deps)).toBe('installed');
  });

  test('anything that is not a plain version is refused before any network call', async () => {
    for (const bad of ['', '1.2', '../x', '0.1.0-beta.1;id', '-H', '0.1.0\n', '1.2.3-a_b', 'latest']) {
      const f = fake(null);
      await expect(installRelease(bad, 'root', f.deps)).rejects.toThrow(/is not a @stage-labs\/metro version/);
      expect(f.calls).toEqual([]);
    }
  });

  test('a tarball other than the registry\'s own, or one that does not match npm\'s sha512, is never unpacked', async () => {
    const elsewhere = fake(null, {
      published: () => Promise.resolve({ tags: { beta: V }, tarball: 'https://evil.example/metro.tgz', integrity: INTEGRITY }),
    });
    await expect(installRelease(V, 'metro', elsewhere.deps)).rejects.toThrow(/unexpected tarball/);
    const swapped = fake(null, { download: () => Promise.resolve(Buffer.from('something else')) });
    await expect(installRelease(V, 'metro', swapped.deps)).rejects.toThrow(/does not match the sha512/);
    expect([...elsewhere.calls, ...swapped.calls].filter((c) => c.startsWith('unpack') || c.startsWith('setup'))).toEqual([]);
  });

  test('no provenance, a bad signature, or a provenance for another tarball or version stops it before anything runs', async () => {
    const cases: Partial<ReleaseDeps>[] = [
      { attestations: () => Promise.resolve({ attestations: [] }) },
      { verifySignature: () => Promise.reject(new Error('the provenance signature does not check out; refused')) },
      { attestations: () => Promise.resolve(attestations(statement(V, '00'.repeat(64)))) },
      { attestations: () => Promise.resolve(attestations(statement('0.1.0-beta.247'))) },
      { attestations: () => Promise.resolve(attestations(statement(), 'text/plain')) },
      { attestations: () => Promise.resolve(attestations({ ...statement(), predicateType: 'https://example.com/other' })) },
    ];
    for (const over of cases) {
      const f = fake(null, over);
      await expect(installRelease(V, 'metro', f.deps)).rejects.toThrow(/refused/);
      expect(f.calls.filter((c) => c.startsWith('unpack') || c.startsWith('setup') || c.startsWith('swap'))).toEqual([]);
    }
  });

  test('a setup that fails leaves the root copy in place', async () => {
    const f = fake('0.1.0-beta.247', {
      setup: () => {
        throw new Error('visudo refused the rules');
      },
    });
    await expect(installRelease(V, 'metro', f.deps)).rejects.toThrow(/visudo/);
    expect(f.calls.some((c) => c.startsWith('swap'))).toBe(false);
  });
});

describe('the provenance must be signed for the publish workflow on main', () => {
  test('the certificate of a real publish names bonustrack/metro publish-cli.yml on main', () => {
    expect(signedByPublisher({ verificationMaterial: { x509CertificateChain: { certificates: [{ rawBytes: PUBLISH_CERT }] } } })).toBe(true);
    expect(signedByPublisher({ verificationMaterial: { certificate: { rawBytes: PUBLISH_CERT } } })).toBe(true);
  });

  test('a bundle signed with a bare key, or with no certificate, is not', () => {
    expect(signedByPublisher({ verificationMaterial: { publicKey: { hint: 'npm' } } })).toBe(false);
    expect(signedByPublisher({})).toBe(false);
  });
});

describe('what root runs must belong to root alone', () => {
  test('a system binary is root-owned, a file of this user is not', () => {
    expect(rootOwned('/bin/sh')).toBe(process.platform !== 'win32');
    if (process.getuid?.() !== 0) expect(rootOwned(import.meta.path)).toBe(false);
  });
});
