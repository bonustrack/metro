/** The Station contract — the one platform-agnostic surface core depends on. Each
 *  platform (xmtp/telegram/discord/webhook) ships a `Station` declaring what core
 *  would otherwise hardcode; core reads the registry and never names a platform. */

import type { VerbDecl } from '../registry-types.js';

/** The cross-platform messaging verbs the MCP exposes as common tools. */
export type Verb = 'send' | 'reply' | 'react' | 'unreact' | 'edit' | 'delete' | 'read';

/** An MCP tool result (text content, optionally flagged as an error). */
export interface ToolResult { content: { type: 'text'; text: string }[]; isError?: boolean }

/** Raised when the daemon rejects an outbound call (e.g. "unsupported verb 'edit'").
 *  Tool handlers let it propagate; the MCP surfaces `.detail` as an isError result
 *  so the model sees WHY a call failed rather than an opaque throw. */
export class MetroCallError extends Error {
  detail: string;
  constructor(detail: string) { super(detail); this.name = 'MetroCallError'; this.detail = detail; }
}

/** A file to attach on a `send` call: a local `path` (preferred) or `url`, with
 *  optional `mime`/`name`. Canonical-mode stations ride these on `send`; native-mode
 *  stations dispatch them one native action per file via `sendAttachments`. */
export interface CanonicalAttachment { path?: string; url?: string; mime?: string; name?: string }

/** What a station tool's handler is given: a bound dispatcher to this station plus
 *  the result helpers, so a manifest never imports the MCP server internals. */
export interface ToolContext {
  /** Dispatch an action to THIS station in-process; returns `{ result }` or throws
   *  a MetroCallError carrying the station's reason. */
  call(action: string, args: Record<string, unknown>): Promise<{ result: unknown }>;
  ok(text: string): ToolResult;
  okJson(value: unknown): ToolResult;
  err(text: string): ToolResult;
  /** Read a local file (for attachment-bearing tools). */
  readFile(path: string): Promise<Buffer>;
}

/** A station-specific MCP tool (e.g. xmtp's `create_channel`, `ask`, `dm`). */
export interface StationTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handle(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** How a station's `send` dispatches attachments: `canonical` = `{kind,url,name}[]`
 *  on the send action (telegram/discord); `native` = one action per file (xmtp);
 *  `none` = no outbound at all (webhook). */
export type AttachmentMode = 'canonical' | 'native' | 'none';

export interface Station {
  /** The `metro://<name>/…` host segment. */
  name: string;
  /** Whether this station reports accounts (surfaced in /health + `list_accounts`). */
  hasAccounts: boolean;
  /** The common verbs this station supports (the capability matrix). */
  supports: ReadonlySet<Verb>;
  /** How outbound `send` attachments are dispatched. */
  attachmentMode: AttachmentMode;
  /** Native-mode attachment dispatch (one native action per file). Only stations
   *  with `attachmentMode: 'native'` implement it; canonical/none leave it unset. */
  sendAttachments?(line: string, atts: CanonicalAttachment[], ctx: ToolContext): Promise<string[]>;
  /** Parse a line for this station → `{ accountId, resource }`, or null if not ours. */
  parseLine(line: string): { accountId: string; resource: string } | null;
  /** This station's daemon verb declarations — aggregated into the verb registry. */
  verbs: VerbDecl[];
  /** Station-specific MCP tools, composed into the tool list alongside the verbs. */
  tools: StationTool[];
}
