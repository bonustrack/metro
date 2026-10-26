import { isRecord } from '@metro-labs/core/is-record';
import { runnerDiagnostic, runnerFailureCode, runnerFailureSummary, type RunnerDiagnostic, type RunnerFailureCode } from '@metro-labs/core/runner-activity';

const SCAN_MAX = 2_048;
const ERROR_FAILURES: Record<NonNullable<RunnerDiagnostic['errorCode']>, RunnerFailureCode> = {
  ENOENT: 'executable', EACCES: 'executable', EPERM: 'executable', ENOEXEC: 'executable', ENOMEM: 'executable',
  ERR_MODULE_NOT_FOUND: 'module', MODULE_NOT_FOUND: 'module', ERR_DLOPEN_FAILED: 'module',
  ECONNREFUSED: 'connection', ECONNRESET: 'connection', ENOTFOUND: 'connection', EAI_AGAIN: 'connection', ETIMEDOUT: 'connection',
  CERT_HAS_EXPIRED: 'connection', UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'connection',
};
const KNOWN = ['status_unavailable', 'session_ended', 'interrupted', 'saved_state', 'authentication', 'executable', 'connection', 'module', 'configuration', 'process_exit', 'session_error'] as const;

interface SessionFailure {
  code: RunnerFailureCode;
  diagnostic?: RunnerDiagnostic;
}

function normalizeFailure(raw: unknown): SessionFailure {
  if (!isRecord(raw) || !runnerFailureCode(raw.code)) return { code: 'session_error' };
  const diagnostic = runnerDiagnostic(raw.diagnostic);
  return { code: raw.code, ...(diagnostic === undefined ? {} : { diagnostic }) };
}

export class SessionError extends Error {
  readonly failure: SessionFailure;

  constructor(failure: SessionFailure) {
    const safe = normalizeFailure(failure);
    super(runnerFailureSummary(safe.code, null, safe.diagnostic));
    this.failure = safe;
  }
}

function statusFailure(status: number | undefined): RunnerFailureCode | null {
  if (status === undefined) return null;
  if (status === 401 || status === 403) return 'authentication';
  if (status === 402) return 'billing';
  if (status === 429) return 'rate_limit';
  return status >= 500 ? 'provider_unavailable' : 'invalid_request';
}

const TEXT_FAILURES: [RunnerFailureCode, RegExp][] = [
  ['authentication', /\bunauthorized\b|\bauthentication (?:failed|error)\b|\binvalid(?:[ -]api)?[ -]key\b/i],
  ['module', /cannot find (?:module|package)|error (?:while )?loading shared libraries|module not found/i],
  ['configuration', /METRO_(?:RUNNER_MCP_URL|AGENT_KEY) is not set|invalid (?:configuration|settings)|failed to parse (?:configuration|settings)|unknown (?:option|argument)/i],
  ['executable', /executable|spawn|command not found/i],
  ['connection', /network|fetch failed|timed? ?out/i],
];

function errorText(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, SCAN_MAX);
  return isRecord(value) && typeof value.message === 'string' ? value.message.slice(0, SCAN_MAX) : '';
}

function evidence(raw: Record<string, unknown>, message: string, source: RunnerDiagnostic['source']): RunnerDiagnostic | undefined {
  const errorCodes = message.match(/\b[A-Z][A-Z_]{2,40}\b/g) ?? [];
  return runnerDiagnostic({
    source, errorCode: raw.code ?? errorCodes.find((code) => Object.hasOwn(ERROR_FAILURES, code)),
    httpStatus: raw.status ?? raw.statusCode ?? Number(/(?:^|\bHTTP(?:\/[12](?:\.\d)?)?\s+|\bstatus(?: code)?[:= ]+)([45]\d\d)\b/i.exec(message)?.[1]),
    exitCode: raw.exitCode ?? Number(/^Claude Code process exited with code (\d{1,3})\b/.exec(message)?.[1]),
    signal: raw.signal ?? /^Claude Code process terminated by signal (SIG[A-Z]{1,8})\b/.exec(message)?.[1],
  });
}

function diagnosticCode(message: string, diagnostic: RunnerDiagnostic | undefined): RunnerFailureCode | null {
  if (/saved Agent SDK state/i.test(message)) return 'saved_state';
  if (diagnostic?.errorCode !== undefined) return ERROR_FAILURES[diagnostic.errorCode];
  return statusFailure(diagnostic?.httpStatus);
}

function processFailure(diagnostic: RunnerDiagnostic | undefined): RunnerFailureCode | null {
  return diagnostic?.exitCode !== undefined || diagnostic?.signal !== undefined ? 'process_exit' : null;
}

function namedFailure(value: unknown, source: RunnerDiagnostic['source']): SessionFailure {
  const errorName = runnerDiagnostic({ source, errorName: isRecord(value) ? value.name : undefined })?.errorName;
  return errorName === undefined ? { code: 'session_error' } : { code: 'session_error', diagnostic: { source, errorName } };
}

export function debugFailure(stage: string, err: unknown): void {
  if (process.env.METRO_RUNNER_DEBUG !== '1') return;
  const text = err instanceof Error ? err.stack ?? `${err.name}: ${err.message}` : String(err);
  process.stderr.write(`metro agent debug (${stage}, this terminal only): ${text.slice(0, 4_000)}\n`);
}

function classify(value: unknown, source: RunnerDiagnostic['source']): SessionFailure {
  const message = errorText(value);
  const known = KNOWN.find((code) => message === runnerFailureSummary(code));
  if (known !== undefined) return { code: known };
  const diagnostic = evidence(isRecord(value) ? value : {}, message, source);
  const code = diagnosticCode(message, diagnostic) ?? TEXT_FAILURES.find(([, pattern]) => pattern.test(message))?.[0] ?? processFailure(diagnostic) ?? 'session_error';
  return code === 'session_error' ? namedFailure(value, source) : { code, ...(diagnostic === undefined ? {} : { diagnostic }) };
}

export function sessionFailure(err: unknown): SessionFailure {
  try {
    if (err instanceof SessionError) return normalizeFailure(err.failure);
    let current = err;
    let result: SessionFailure = { code: 'session_error' };
    for (let depth = 0; depth < 4; depth++) {
      const next = classify(current, 'exception');
      if (next.code !== 'session_error' || (result.code === 'session_error' && result.diagnostic === undefined)) result = next;
      if (!isRecord(current) || current.cause === undefined) break;
      current = current.cause;
    }
    return result;
  } catch {
    return { code: 'session_error' };
  }
}

export const failureSummary = (err: unknown): string => {
  const failure = sessionFailure(err);
  return runnerFailureSummary(failure.code, null, failure.diagnostic);
};

export class StartupDiagnostics {
  private tail = '';
  private observed: SessionFailure | null = null;

  stderr(text: string): void {
    const head = text.slice(0, SCAN_MAX);
    const candidates = [head, (this.tail + head).slice(-SCAN_MAX), text.length > SCAN_MAX ? text.slice(-SCAN_MAX) : ''];
    for (const candidate of candidates) {
      const failure = classify(candidate, 'stderr');
      if (failure.code !== 'session_error' && (failure.code !== 'process_exit' || this.observed === null)) this.observed = failure;
    }
    this.tail = (this.tail + (text.length > SCAN_MAX ? text.slice(-SCAN_MAX) : text)).slice(-SCAN_MAX);
  }

  failure(err: unknown): SessionFailure {
    const failure = sessionFailure(err);
    const observed = this.observed;
    if (observed === null || !['session_error', 'process_exit'].includes(failure.code)) return failure;
    return { ...observed, diagnostic: runnerDiagnostic({ ...failure.diagnostic, ...observed.diagnostic }) };
  }

  clear(): void {
    this.tail = '';
    this.observed = null;
  }
}
