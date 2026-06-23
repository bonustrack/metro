import { serializeTrainError, type TrainErrorInfo } from '../train-error.js';
import type { Normalized } from './messaging-normalize.js';

export const emit = (e: unknown): void =>
  void process.stdout.write(JSON.stringify(e) + '\n');

export const respond = (
  id: string,
  body: { result?: unknown; error?: string; errorInfo?: TrainErrorInfo },
): void =>
  void process.stdout.write(
    JSON.stringify({ op: 'response', id, ...body }) + '\n',
  );

export const mintId = (): string =>
  `msg_${Math.random().toString(36).slice(2, 10)}`;

type Args = Record<string, unknown>;

export interface CallMsg {
  op: 'call';
  id: string;
  action: string;
  args: Args;
}

export type StationHandler = (id: string, args: Args) => void | Promise<void>;

export interface StationConfig {
  handlers: Record<string, StationHandler>;
  normalize: (action: string, args: Args) => Normalized;
  preDispatch?: (id: string, action: string) => boolean;
}

export function makeStation({ handlers, normalize, preDispatch }: StationConfig) {
  const known = Object.keys(handlers).join(', ');
  return async function handleCall(msg: CallMsg): Promise<void> {
    const { id } = msg;
    const { action, args } = normalize(msg.action, msg.args);
    try {
      if (preDispatch?.(id, action)) return;
      const handler = handlers[action];
      if (!handler) {
        respond(id, { error: `unknown action '${action}' (have: ${known})` });
        return;
      }
      await handler(id, args);
    } catch (err) {
      respond(id, serializeTrainError(err));
    }
  };
}
