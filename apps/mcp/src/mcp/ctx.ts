import { readFile } from 'node:fs/promises';
import { forwardTrainCall } from '../daemon/train-call.js';
import { errMsg, log } from '../daemon/log.js';
import { TrainError } from '../daemon/train-error.js';
import { type ToolContext, type ToolResult } from '../stations/types.js';

export async function metroCall(
  train: string,
  action: string,
  args: Record<string, unknown>,
): Promise<{ result: unknown }> {
  const line = typeof args.line === 'string' ? args.line : undefined;
  log.info({ train, action, line }, 'metro: dispatching train call');
  let response;
  try {
    response = await forwardTrainCall(train, action, args);
  } catch (err) {
    log.warn(
      { train, action, line, err: errMsg(err) },
      'metro: train call failed to dispatch',
    );
    throw new TrainError(
      'metro_call_failed',
      `metro ${action} ${train}: ${errMsg(err)}`,
    );
  }
  if (response.error) {
    log.warn(
      { train, action, line, err: response.error },
      'metro: train call returned error',
    );
    throw new TrainError(
      'metro_call_error',
      `metro ${action} ${train}: ${response.error}`,
    );
  }
  log.info({ train, action, line }, 'metro: train call ok');
  return { result: response.result ?? null };
}

export const ok = (text: string): ToolResult => ({
  content: [{ type: 'text', text }],
});
export const okJson = (v: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(v, null, 2) }],
});
export const errResult = (text: string): ToolResult => ({
  content: [{ type: 'text', text }],
  isError: true,
});
export const toErr = (name: string, e: unknown): ToolResult =>
  e instanceof TrainError
    ? errResult(e.message)
    : errResult(`metro ${name} failed: ${String(e)}`);

export const makeCtx = (station: string): ToolContext => ({
  call: (action, args) => metroCall(station, action, args),
  ok,
  okJson,
  err: errResult,
  readFile: (path) => readFile(path),
});
