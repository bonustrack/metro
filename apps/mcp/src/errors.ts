import type { McpErrorCode } from '@metro-labs/http/mcp-server-protocol';

export class CallError extends Error {
  constructor(
    readonly code: McpErrorCode,
    message: string,
  ) {
    super(message);
  }
}
