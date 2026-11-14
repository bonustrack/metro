import type { McpErrorCode } from '@metro-labs/http/mcp-server-protocol';

export class CallError extends Error {
  constructor(
    readonly code: McpErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class VendorRpcError extends CallError {
  constructor(
    readonly said: string,
    readonly rpcCode: number,
    readonly data: unknown,
  ) {
    super('vendor_error', `The connector answered with an error: ${said}`);
  }
}
