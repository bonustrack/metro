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

export { mintId } from '../ids.js';

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
}

const lineTag = (args: Args): string =>
  typeof args.line === 'string' ? args.line : '?';

export function makeStation({ handlers, normalize }: StationConfig) {
  const known = Object.keys(handlers).join(', ');
  return async function handleCall(msg: CallMsg): Promise<void> {
    const { id } = msg;
    let action = msg.action;
    let args: Args = msg.args;
    try {
      ({ action, args } = normalize(msg.action, msg.args));
      emit({ op: 'log', text: `call ${action} recv (line=${lineTag(args)})` });
      const handler = handlers[action];
      if (!handler) {
        respond(id, { error: `unknown action '${action}' (have: ${known})` });
        return;
      }
      await handler(id, args);
      emit({ op: 'log', text: `call ${action} done (line=${lineTag(args)})` });
    } catch (err) {
      const info = serializeTrainError(err);
      emit({
        op: 'log',
        text: `call ${action} FAILED (line=${lineTag(args)}): ${info.error}`,
      });
      respond(id, info);
    }
  };
}
