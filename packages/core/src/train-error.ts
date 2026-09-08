export interface TrainErrorInfo {
  code: string;
  message: string;
  retryable?: boolean;
  retryAfterMs?: number;
}

export class TrainError extends Error {
  readonly code: string;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
  constructor(
    code: string,
    message: string,
    opts?: { retryable?: boolean; retryAfterMs?: number },
  ) {
    super(message);
    this.name = 'TrainError';
    this.code = code;
    this.retryable = opts?.retryable;
    this.retryAfterMs = opts?.retryAfterMs;
  }
  toErrorInfo(): TrainErrorInfo {
    return {
      code: this.code,
      message: this.message,
      ...(this.retryable !== undefined ? { retryable: this.retryable } : {}),
      ...(this.retryAfterMs !== undefined
        ? { retryAfterMs: this.retryAfterMs }
        : {}),
    };
  }
}

export function serializeTrainError(err: unknown): {
  error: string;
  errorInfo?: TrainErrorInfo;
} {
  if (err instanceof TrainError)
    return { error: err.message, errorInfo: err.toErrorInfo() };
  return { error: err instanceof Error ? err.message : String(err) };
}

export function coerceErrorInfo(v: unknown): TrainErrorInfo | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.code !== 'string' || typeof o.message !== 'string')
    return undefined;
  const info: TrainErrorInfo = { code: o.code, message: o.message };
  if (typeof o.retryable === 'boolean') info.retryable = o.retryable;
  if (typeof o.retryAfterMs === 'number') info.retryAfterMs = o.retryAfterMs;
  return info;
}
