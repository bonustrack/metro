import type { TrainCallResponse } from './protocol.js';

export type TrainCallBackend = (
  train: string,
  action: string,
  args: unknown,
) => Promise<TrainCallResponse>;

let backend: TrainCallBackend | null = null;

export function setTrainCallBackend(fn: TrainCallBackend): void {
  backend = fn;
}

export function forwardTrainCall(
  train: string,
  action: string,
  args: unknown,
): Promise<TrainCallResponse> {
  if (!backend) throw new Error('train-call backend not wired');
  return backend(train, action, args);
}
