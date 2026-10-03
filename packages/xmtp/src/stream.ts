import { errMsg } from '@metro-labs/core/log';
import { ConsentState } from '@xmtp/node-sdk';
import { network, type NetworkBackoff } from './network.js';

interface StreamOptions<T> {
  consentStates: ConsentState[];
  retryOnFail: false;
  onError: (error: Error) => void;
  onValue: (message: T) => void;
}

interface StreamSource<T> {
  streamAllMessages: (options: StreamOptions<T>) => Promise<AsyncIterable<T>>;
}

interface StreamRuntime {
  backoff: NetworkBackoff;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  report: (message: string) => void;
}

const defaultRuntime: StreamRuntime = {
  backoff: network,
  now: Date.now,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  report: (message) => { process.stderr.write(`xmtp: ${message}\n`); },
};

export async function streamMessages<T>(
  source: StreamSource<T>,
  handle: (message: T) => Promise<void>,
  runtime: StreamRuntime = defaultRuntime,
): Promise<never> {
  let delay = 5000;
  for (;;) {
    const started = runtime.now();
    let delivery = Promise.resolve();
    try {
      const stream = await runtime.backoff.run(() => source.streamAllMessages({
        consentStates: [ConsentState.Allowed, ConsentState.Unknown],
        retryOnFail: false,
        onValue: (message) => {
          delivery = delivery.then(() => handle(message)).catch((error: unknown) => {
            runtime.report(`message handler failed: ${errMsg(error)}`);
          });
        },
        onError: (error) => {
          runtime.backoff.note(error);
          runtime.report(`stream error: ${errMsg(error)}`);
        },
      }));
      const iterator = stream[Symbol.asyncIterator]();
      while (!(await iterator.next()).done) await delivery;
    } catch (error) {
      runtime.backoff.note(error);
      runtime.report(`stream error: ${errMsg(error)}`);
    }
    await delivery;
    if (runtime.now() - started >= 60_000) delay = 5000;
    const wait = Math.max(delay, runtime.backoff.remaining());
    runtime.report(`stream ended; retry in ${Math.ceil(wait / 1000)}s`);
    await runtime.wait(wait);
    delay = Math.min(delay * 2, 300_000);
  }
}
