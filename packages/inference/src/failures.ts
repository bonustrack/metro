import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { stringOf } from '@metro-labs/http/api-http';
import { currentAttempt } from './attempts.js';
import { parseEvent, SseParser } from './frames.js';
import type { Route } from './model-config.js';

const MESSAGE_MAX = 300;
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
  log.warn({ connection: site.connection, model: site.model, ...failure, message: failure.message.slice(0, MESSAGE_MAX) }, what);
}

export class StreamErrors {
  private readonly parser = new SseParser();

  constructor(private readonly site: FailureSite) {}

  feed(text: string): void {
    for (const raw of this.parser.push(text)) {
      if (raw.event !== 'error' && !ERROR_DATA.test(raw.data)) continue;
      const data = parseEvent(raw)?.data ?? {};
      const error = isRecord(data.error) ? data.error : {};
      noteFailure(this.site, { code: stringOf(error.type) || stringOf(error.code), message: stringOf(error.message) }, 'gateway: the provider sent an error in the middle of its stream');
    }
  }
}
