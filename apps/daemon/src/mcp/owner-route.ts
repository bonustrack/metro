import type { MetroEvent } from '@metro-labs/core/events';
import { log } from '@metro-labs/core/log';
import { agentIdForLine, lineReceives } from '../agents/map.js';
import { ownerLine } from '../approvals/owner-line.js';
import { metroNotice } from '../channels/notice.js';

export type Publish = (event: MetroEvent) => void;

export interface OwnerRoute {
  promptLine: (requestId: string, callLine?: string) => string | undefined;
  knownLine: () => string | undefined;
  live: () => boolean;
  publish: Publish;
}

let route: OwnerRoute | undefined;

export function connectOwnerRoute(next: OwnerRoute | undefined): void {
  route = next;
}

export const ownerPromptLine = (requestId: string, callLine?: string): string | undefined => route?.promptLine(requestId, callLine);

export const agentHearsNotices = (): boolean => route?.live() === true;

const reachable = (line: string | undefined): line is string => line !== undefined && agentIdForLine(line) !== undefined && lineReceives(line);

export function tellAgent(text: string, preferred: string | undefined, publish: Publish | undefined = route?.publish): boolean {
  const line = [preferred, route?.knownLine(), ownerLine()?.line].find(reachable);
  if (publish === undefined || line === undefined) {
    log.warn('approvals: no chat is known to tell the agent the answer');
    return false;
  }
  publish(metroNotice(line, text));
  return true;
}
