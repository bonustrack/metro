import { approvalId } from '@metro-labs/core/ids';
import { errMsg, log } from '@metro-labs/core/log';
import { forgetPromptsOf, holdPrompt, type Behavior } from '../approvals/pending.js';
import { promptBody } from '../mcp/permission-prompt.js';
import type { ToolAsk } from './brain.js';

export class CallApprovals {
  private closed = false;

  constructor(
    private readonly line: string,
    private readonly post: (text: string) => Promise<void>,
  ) {}

  ask(ask: ToolAsk, answer: (behavior: Behavior) => void): string | null {
    if (this.closed) return null;
    const id = approvalId();
    const preview = JSON.stringify(ask.input);
    holdPrompt(
      { requestId: id, tool: ask.tool, description: ask.description, preview, line: this.line, at: Date.now() },
      this,
      (behavior) => {
        answer(behavior);
        return Promise.resolve();
      },
      this.post,
    );
    this.post(promptBody({ request_id: id, tool_name: ask.tool, description: ask.description, input_preview: preview })).catch((err: unknown) => {
      log.warn({ err: errMsg(err) }, 'voice: could not ask for an approval in the chat of the call');
    });
    return id;
  }

  close(): void {
    this.closed = true;
    forgetPromptsOf(this);
  }
}
