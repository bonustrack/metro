import { errMsg, log } from '@metro-labs/core/log';

const BUILT_IN = '0.157.1';
const REGISTRY = 'https://registry.npmjs.org/@openai/codex/latest';
const OVERRIDE_RE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/;
const STABLE_RE = /^\d+\.\d+\.\d+$/;
const FRESH_MS = 6 * 3_600_000;
const FETCH_MS = 5_000;

let learned: { version: string; at: number } | null = null;

const parts = (version: string): number[] => version.split('.').map(Number);

function newer(a: string, b: string): boolean {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

export function codexVersion(): string {
  const wanted = process.env.METRO_CODEX_VERSION?.trim() ?? '';
  if (wanted !== '' && OVERRIDE_RE.test(wanted)) return wanted;
  if (wanted !== '') log.warn({ value: wanted }, 'gateway: METRO_CODEX_VERSION is not a version like 0.157.1; using the known one');
  return learned !== null && newer(learned.version, BUILT_IN) ? learned.version : BUILT_IN;
}

async function latestOnNpm(): Promise<string> {
  const res = await fetch(process.env.METRO_CODEX_REGISTRY ?? REGISTRY, { signal: AbortSignal.timeout(FETCH_MS) });
  const body: unknown = await res.json();
  const version = typeof body === 'object' && body !== null ? (body as { version?: unknown }).version : undefined;
  if (!res.ok || typeof version !== 'string' || !STABLE_RE.test(version)) throw new Error(`npm answered ${String(res.status)} without a stable version`);
  return version;
}

export async function learnCodexVersion(now = Date.now()): Promise<string> {
  if (learned !== null && now - learned.at < FRESH_MS) return codexVersion();
  try {
    learned = { version: await latestOnNpm(), at: now };
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'gateway: the latest Codex version could not be read from npm; using the known one');
    learned = { version: learned?.version ?? BUILT_IN, at: now };
  }
  return codexVersion();
}
