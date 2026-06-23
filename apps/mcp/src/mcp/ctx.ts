import { readFile } from 'node:fs/promises';
import { ipcCall } from '../daemon/ipc.js';
import { TrainError } from '../daemon/train-error.js';
import { type ToolContext, type ToolResult } from '../stations/types.js';

export async function metroCall(
  train: string,
  action: string,
  args: Record<string, unknown>,
): Promise<{ result: unknown }> {
  const resp = await ipcCall({ op: 'forward-call', train, action, args });
  if (!resp.ok)
    throw new TrainError(
      'metro_call_failed',
      `metro ${action} ${train}: ${resp.error}`,
    );
  if (!('response' in resp))
    throw new TrainError(
      'metro_call_malformed',
      `metro ${action} ${train}: malformed daemon response`,
    );
  if (resp.response.error)
    throw new TrainError(
      'metro_call_error',
      `metro ${action} ${train}: ${resp.response.error}`,
    );
  return { result: resp.response.result ?? null };
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
