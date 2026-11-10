import type { MetroEvent } from '@metro-labs/core/events';
import { log } from '@metro-labs/core/log';
import { agentIdForLine, lineReceives } from '../agents/map.js';
import { ownerLine } from '../approvals/owner-line.js';
import { metroNotice } from '../channels/notice.js';

export interface OwnerRoute {
  promptLine: (requestId: string, callLine?: string) => string | undefined;
  knownLine: () => string | undefined;
  live: () => boolean;
  publish: (event: MetroEvent) => void;
}

let route: OwnerRoute | undefined;

export function connectOwnerRoute(next: OwnerRoute | undefined): void {
  route = next;
}

export const ownerPromptLine = (requestId: string, callLine?: string): string | undefined => route?.promptLine(requestId, callLine);

const reachable = (line: string | undefined): line is string => line !== undefined && agentIdForLine(line) !== undefined && lineReceives(line);

const noticeLine = (preferred: string | undefined): string | undefined => [preferred, route?.knownLine(), ownerLine()?.line].find(reachable);

export const canTellAgent = (preferred: string | undefined): boolean => route?.live() === true && noticeLine(preferred) !== undefined;

export function tellAgent(text: string, preferred: string | undefined): void {
  const line = noticeLine(preferred);
  if (route === undefined || line === undefined) log.warn('approvals: no chat is known to tell the agent the answer');
  else route.publish(metroNotice(line, text));
}
