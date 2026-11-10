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
    readonly rpcCode: number | null,
    message: string,
  ) {
    super('vendor_error', message);
  }
}
