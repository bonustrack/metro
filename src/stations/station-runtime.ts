import { respond } from './wire-core.js';
import { serializeTrainError } from '../train-error.js';
import type { Normalized } from './messaging-normalize.js';

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
