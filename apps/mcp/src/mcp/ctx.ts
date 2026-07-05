import { readFile } from 'node:fs/promises';
import { forwardTrainCall } from '../daemon/train-call.js';
import { errMsg } from '../daemon/log.js';
import { TrainError } from '../daemon/train-error.js';
import { type ToolContext, type ToolResult } from '../stations/types.js';

export async function metroCall(
  train: string,
  action: string,
  args: Record<string, unknown>,
): Promise<{ result: unknown }> {
  let response;
  try {
    response = await forwardTrainCall(train, action, args);
  } catch (err) {
    throw new TrainError(
      'metro_call_failed',
      `metro ${action} ${train}: ${errMsg(err)}`,
    );
  }
  if (response.error)
    throw new TrainError(
      'metro_call_error',
      `metro ${action} ${train}: ${response.error}`,
    );
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
