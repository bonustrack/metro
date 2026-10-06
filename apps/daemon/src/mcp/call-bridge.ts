import { CALL_NOTICE, sameCall, type CallNotice, type CallRoute } from '@metro-labs/core/call';
import { errMsg, log } from '@metro-labs/core/log';
import { eventInScope } from '../agents/scope.js';
import { revokeCallPrompts } from '../approvals/pending.js';
import { sharedCalls } from '../voice/shared.js';
import type { McpSession } from './session.js';

export const callInScope = (scope: Set<string>, route: CallRoute): boolean =>
  scope.has(route.agentId) && eventInScope(scope, route.line);

export function connectCallBridge(current: () => McpSession | undefined): void {
  let owner: McpSession | undefined;
  let route: CallRoute | undefined;
  const available = (wanted: CallRoute): boolean => {
    const session = current();
    return session !== undefined && session.streamAttached && session.server.getClientVersion()?.name === 'metro-sdk-runner' &&
      callInScope(session.scope, wanted) && (route === undefined || owner === session);
  };
  const boundTo = (session: McpSession | undefined, wanted: CallRoute): boolean => session === owner && route !== undefined && sameCall(route, wanted);
  const forgetEnded = (notice: CallNotice): void => {
    if (notice.type === 'ended' && route !== undefined && sameCall(route, notice.route)) {
      owner = undefined;
      route = undefined;
    }
  };
  sharedCalls.connect({
    available,
    notify: (notice: CallNotice): boolean => {
      const session = current();
      const bound = notice.type === 'started' ? available(notice.route) : boundTo(session, notice.route);
      forgetEnded(notice);
      if (session === undefined || !session.streamAttached || !callInScope(session.scope, notice.route) || !bound) return false;
      if (notice.type === 'started') {
        owner = session;
        route = notice.route;
      }
      session.server.notification({ method: CALL_NOTICE, params: { ...notice, meta: { line: notice.route.line } } }).catch((err: unknown) => {
        log.warn({ err: errMsg(err) }, 'sdk-call: notification failed');
        sharedCalls.end(notice.route);
      });
      return true;
    },
    revoked: (ended) => { revokeCallPrompts(ended); },
  });
}
