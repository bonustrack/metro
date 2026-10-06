import { approvalId } from '@metro-labs/core/ids';
import type { CallSource } from '@metro-labs/core/call';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { log } from '@metro-labs/core/log';
import type { Asker } from './link.js';

const DENIED = 'The owner did not approve this.';

export interface ApprovalAsk { tool: string; worker: string | null }
export type ApprovalWatch = (id: string, ask: ApprovalAsk | null) => void;

export interface ApprovalBinding { call: CallSource; signal: AbortSignal }
export type BindApproval = (tool: string, input: Record<string, unknown>) => ApprovalBinding | null | undefined;

export function approvalsThrough(asker: Asker, waiting: ApprovalWatch = () => undefined, bind: BindApproval = () => undefined): CanUseTool {
  return async (tool, input, options) => {
    const binding = bind(tool, input);
    if (binding === null) return { behavior: 'deny', message: 'This speech target is no longer authorized for the active call.' };
    const signal = binding === undefined ? options.signal : AbortSignal.any([options.signal, binding.signal]);
    const id = approvalId();
    const worker = options.agentID ?? null;
    log.info({ tool, id, worker }, 'sdk-runner: a tool waits for the owner’s approval');
    waiting(id, { tool, worker });
    const behavior = await asker.ask(
      {
        request_id: id,
        tool_name: tool,
        description: options.description ?? options.title ?? options.decisionReason ?? '',
        input_preview: JSON.stringify(input),
        ...(binding === undefined ? {} : { call: binding.call }),
      },
      signal,
    ).finally(() => { waiting(id, null); });
    log.info({ tool, id, behavior }, 'sdk-runner: the owner answered');
    return behavior === 'allow' && !signal.aborted ? { behavior, updatedInput: input } : { behavior: 'deny', message: DENIED };
  };
}
