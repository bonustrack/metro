import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { stringOf } from '@metro-labs/http/api-http';
import { currentAttempt } from './attempts.js';
import { parseEvent, SseParser } from './frames.js';
import type { Route } from './model-config.js';

const MESSAGE_MAX = 300;

let keepProviderText = true;

export const quietProviderText = (): void => {
  keepProviderText = false;
};

export const providerText = (text: string): string | undefined => (keepProviderText ? text.slice(0, MESSAGE_MAX) : undefined);
const ERROR_DATA = /^\{\s*"type"\s*:\s*"error"/;

export interface FailureSite {
  connection: string;
  model: string;
}

export interface Failure {
  code: string;
  message: string;
  status?: number;
}

export const siteOf = (route: Route): FailureSite => ({ connection: route.connection.label, model: route.model });

export function noteFailure(site: FailureSite, failure: Failure, what: string): void {
  currentAttempt()?.failed();
  log.warn({ connection: site.connection, model: site.model, ...failure, message: providerText(failure.message) }, what);
}

const STOP_DATA = /^\{\s*"type"\s*:\s*"message_stop"/;

export class StreamErrors {
  private readonly parser = new SseParser();
  private ended = false;

  constructor(private readonly site: FailureSite) {}

  get settled(): boolean {
    return this.ended;
  }

  cut(): void {
    noteFailure(this.site, { code: 'stream_cut', message: '' }, 'gateway: the provider ended its stream before the answer was complete');
  }

  feed(text: string): void {
    for (const raw of this.parser.push(text)) {
      if (raw.event === 'message_stop' || STOP_DATA.test(raw.data)) this.ended = true;
      if (raw.event !== 'error' && !ERROR_DATA.test(raw.data)) continue;
      this.ended = true;
      const data = parseEvent(raw)?.data ?? {};
      const error = isRecord(data.error) ? data.error : {};
      noteFailure(this.site, { code: stringOf(error.type) || stringOf(error.code), message: stringOf(error.message) }, 'gateway: the provider sent an error in the middle of its stream');
    }
  }
}
