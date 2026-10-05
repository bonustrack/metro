import { randomInt } from 'node:crypto';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { log } from '@metro-labs/core/log';
import type { Asker } from './link.js';

const ID_LETTERS = 'abcdefghijkmnopqrstuvwxyz';
const ID_LENGTH = 5;
const DENIED = 'The owner did not approve this.';

export const approvalId = (): string => Array.from({ length: ID_LENGTH }, () => ID_LETTERS[randomInt(ID_LETTERS.length)]).join('');

export interface ApprovalAsk { tool: string; worker: string | null }
export type ApprovalWatch = (id: string, ask: ApprovalAsk | null) => void;

export function approvalsThrough(asker: Asker, waiting: ApprovalWatch = () => undefined): CanUseTool {
  return async (tool, input, options) => {
    const id = approvalId();
    log.info({ tool, id, worker: options.agentID ?? null }, 'sdk-runner: a tool waits for the owner’s approval');
    waiting(id, { tool, worker: options.agentID ?? null });
    const behavior = await asker.ask(
      {
        request_id: id,
        tool_name: tool,
        description: options.description ?? options.title ?? options.decisionReason ?? '',
        input_preview: JSON.stringify(input),
      },
      options.signal,
    ).finally(() => { waiting(id, null); });
    log.info({ tool, id, behavior }, 'sdk-runner: the owner answered');
    return behavior === 'allow' ? { behavior, updatedInput: input } : { behavior, message: DENIED };
  };
}
