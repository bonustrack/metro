/**
 * Metro MCP — the Claude Code Channel MCP surface, served IN-PROCESS by the daemon.
 *
 * Bridges Metro's inbound chat stream into a running coding session as channel
 * push events, exposes messaging tools for outbound (text + media), and relays
 * tool-approval permission prompts out via Metro so they can be answered from a
 * phone.
 *
 * Mounted at the ROOT path `/` on the daemon's HTTP server (see
 * dispatcher/server.ts) so it can sit behind its own host, e.g. https://mcp.metro.box.
 * Inbound comes straight from the in-process history tail (followTail); outbound
 * goes straight to the in-process call dispatch (ipcCall forward-call) — there is
 * no HTTP bridge and no METRO_MONITOR_TOKEN. The daemon calls createMetroMcp()
 * once to get the request handler + the inbound pump.
 *
 * Spec: https://code.claude.com/docs/en/channels-reference
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { ipcCall } from '../ipc.js'
import { drainTail, followTail, historySize, type TailOpts } from '../broker/history-stream.js'
import { gatherAccounts } from '../monitor-api.js'
import type { HistoryEntry } from '../history.js'

// --- Config ------------------------------------------------------------------
// Sender allowlist + station gate come from the environment (the daemon loads
// .env). Default allowlist: Less's primary tony-account XMTP inbox. A `*`
// disables gating (NOT recommended — this is a prompt-injection surface).
const ALLOWLIST_DEFAULT = 'bee7314f7127ef53b4e3bf5256e54b0a1acdc3698d064fb1029bd8f83ecc1186'
const STATIONS_DEFAULT = 'xmtp,telegram,discord'
const parseAllowlist = (raw: string): string[] =>
  raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
const parseStations = (raw: string): Set<string> =>
  new Set(raw.split(',').map(s => s.trim()).filter(Boolean))
const getAllowlist = (): string[] =>
  parseAllowlist(process.env.METRO_CHANNEL_ALLOWLIST ?? ALLOWLIST_DEFAULT)
const getStations = (): Set<string> =>
  parseStations(process.env.METRO_CHANNEL_STATIONS ?? STATIONS_DEFAULT)
const log = (...a: unknown[]): void => console.error('[metro-mcp]', ...a)

// --- MCP server (two-way channel + permission relay) ------------------------
const mcp = new Server(
  { name: 'metro', version: '0.1.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
      tools: {},
    },
    instructions:
      'Messages from Metro chat arrive as <channel source="metro" line="..." from="..." ' +
      'station="..." message_id="...">. To respond, use the messaging tools, always passing the ' +
      '`line` attribute verbatim (the station is derived from it): `send` (text and/or media via ' +
      '`attachments`, optional `reply_to`), `reply` (quote a `message_id` with `text`), `react`/' +
      '`unreact` (emoji on a `message_id`), `edit`/`delete` (a `message_id`), and `read` (recent ' +
      'history). Station support varies: webhook lines accept no outbound; xmtp has no edit/delete; ' +
      'telegram has no read - the tool returns the daemon\'s reason if unsupported. Inbound ' +
      'attachments are surfaced as a note with an absolute `local_path` - Read that path to view ' +
      'the file. Tool-approval prompts are relayed to the same chat - answer "yes <id>"/"no <id>".',
  },
)

// --- Outbound: reply tool -> POST /api/call/<train>/<action> ----------------
// Raised when the daemon answers non-2xx (e.g. "unsupported verb 'edit' on
// xmtp"). The verb tools catch this and surface `.detail` as the tool result so
// the model sees WHY it failed, with isError semantics, rather than an opaque
// throw. `detail` is the status + body snippet from the daemon.
class MetroCallError extends Error {
  detail: string
  constructor(detail: string) { super(detail); this.name = 'MetroCallError'; this.detail = detail }
}

// Dispatch an outbound call to a station IN-PROCESS via the daemon's forward-call
// IPC — the exact path POST /api/call used (handleCall in monitor-api.ts). Returns
// `{ result }` on success (the same shape the HTTP endpoint returned) and throws
// MetroCallError carrying the station's reason on failure so callers relay it.
async function metroCall(train: string, action: string, args: Record<string, unknown>): Promise<unknown> {
  const resp = await ipcCall({ op: 'forward-call', train, action, args })
  if (!resp.ok) throw new MetroCallError(`metro ${action} ${train}: ${resp.error}`)
  if (!('response' in resp)) throw new MetroCallError(`metro ${action} ${train}: malformed daemon response`)
  if (resp.response.error) throw new MetroCallError(`metro ${action} ${train}: ${resp.response.error}`)
  return { result: resp.response.result ?? null }
}

const trainOf = (line: string): string => line.split('/')[2] ?? ''

async function metroSend(line: string, text: string, replyTo?: string) {
  const args: Record<string, string> = { line, text }
  if (replyTo) args.replyTo = replyTo
  await metroCall(trainOf(line), 'send', args)
}

// The monitor request body is capped at ~256KiB; base64 inflates by ~4/3, so a
// raw file over ~190KiB won't fit once encoded. Used to pre-check xmtp
// sendAttachment (which must base64 the bytes through this path).
const XMTP_ATTACH_MAX_BYTES = 190 * 1024

// Best-effort mime from a file extension (for sendAttachment, which needs one).
const guessMime = (path: string): string => {
  const ext = (path.split('.').pop() ?? '').toLowerCase()
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', heic: 'image/heic', mp4: 'video/mp4', mov: 'video/quicktime',
    webm: 'video/webm', m4v: 'video/x-m4v', m4a: 'audio/mp4', mp3: 'audio/mpeg',
    ogg: 'audio/ogg', wav: 'audio/wav', pdf: 'application/pdf',
  }
  return map[ext] ?? 'application/octet-stream'
}
const isImageMime = (mime: string) => mime.toLowerCase().startsWith('image/')
const isImageExt = (path: string) => /\.(png|jpe?g|gif|webp|heic|bmp|svg)$/i.test(path)

// Images -> sendImage {line, path}: the daemon reads the file itself (no base64
// round-trip). Confirmed in src/stations/xmtp/actions.ts:103-121.
async function metroSendImage(line: string, path: string) {
  await metroCall(trainOf(line), 'sendImage', { line, path })
}
// Non-images -> sendAttachment {line, name, mime, dataB64}: read + base64 here.
// Confirmed in src/stations/xmtp/actions.ts:92-101.
async function metroSendAttachment(line: string, path: string, mime?: string, name?: string) {
  const buf = await readFile(path)
  if (buf.byteLength > XMTP_ATTACH_MAX_BYTES) {
    throw new MetroCallError(
      `attachment '${path}' is ${(buf.byteLength / 1024).toFixed(0)} KiB; xmtp non-image files ` +
      `over ~190 KiB (256 KiB once base64-encoded) cannot be sent via this MCP path. ` +
      `Send it as an image, host it elsewhere, or use the metro CLI directly.`,
    )
  }
  await metroCall(trainOf(line), 'sendAttachment', {
    line, name: name ?? path.split('/').pop() ?? 'attachment',
    mime: mime ?? guessMime(path), dataB64: buf.toString('base64'),
  })
}

// Canonical attachment descriptor as accepted by the `send` action for
// telegram/discord (matches src/messaging.ts Attachment +
// cli/messaging.ts toAttachments: {kind,url:<path>,name}). The daemon's
// normalize layer turns these into the station-native multipart inputs.
type CanonicalAttachment = { path?: string; url?: string; mime?: string; name?: string }
const toCanonical = (a: CanonicalAttachment) => {
  const src = a.path ?? a.url ?? ''
  const mime = a.mime ?? (src ? guessMime(src) : '')
  return {
    kind: isImageMime(mime) || isImageExt(src) ? 'image' : 'file',
    url: src,
    name: a.name ?? src.split('/').pop() ?? undefined,
    ...(a.mime ? { mime: a.mime } : {}),
  }
}

// XMTP ignores canonical `attachments` on `send`, so dispatch one native action
// per attachment: images -> sendImage (path), other files -> sendAttachment
// (base64). Returns the list of kinds dispatched for the confirmation string.
async function xmtpSendAttachments(line: string, atts: CanonicalAttachment[]): Promise<string[]> {
  const sent: string[] = []
  for (const a of atts) {
    const src = a.path ?? a.url ?? ''
    if (!src) continue
    const mime = a.mime ?? guessMime(src)
    if (isImageMime(mime) || isImageExt(src)) { await metroSendImage(line, src); sent.push('image') }
    else { await metroSendAttachment(line, src, a.mime, a.name); sent.push('file') }
  }
  return sent
}

// Shared JSON-schema fragment: every verb takes the metro line.
const lineProp = { type: 'string', description: 'The metro:// line (from the inbound <channel> tag). The station is derived from it.' } as const
const msgIdProp = { type: 'string', description: 'The target message_id.' } as const

const attachmentItem = {
  type: 'object',
  description: 'A file to attach. Provide `path` (preferred, absolute local path) or `url`.',
  properties: {
    path: { type: 'string', description: 'Absolute local path to the file (the daemon reads it).' },
    url: { type: 'string', description: 'http(s) URL (alternative to path).' },
    mime: { type: 'string', description: 'MIME type (guessed from extension if omitted).' },
    name: { type: 'string', description: 'Filename to present (defaults to basename).' },
  },
} as const

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description:
        'Reply to a specific message in a Metro conversation (text quotes the target). ' +
        'Args: line, message_id, text. The station is derived from the line. ' +
        'Not supported on webhook lines (no outbound). On discord/telegram the reply quotes ' +
        'the target message; attachments are not supported on reply (use `send` for media).',
      inputSchema: {
        type: 'object',
        properties: { line: lineProp, message_id: msgIdProp, text: { type: 'string', description: 'The reply text.' } },
        required: ['line', 'message_id', 'text'],
      },
    },
    {
      name: 'send',
      description:
        'Send a message (and/or media) to a Metro conversation. Args: line, text?, reply_to?, ' +
        'attachments?. The station is derived from the line. Not supported on webhook lines ' +
        '(no outbound). For telegram/discord, attachments are passed as local paths the daemon ' +
        'reads. For xmtp, each attachment is dispatched natively: images via sendImage, other ' +
        'files via sendAttachment (base64; xmtp non-image files over ~190 KiB are rejected with ' +
        'a clear error). At least one of text/attachments is required.',
      inputSchema: {
        type: 'object',
        properties: {
          line: lineProp,
          text: { type: 'string', description: 'The message text (optional if sending only media).' },
          reply_to: { type: 'string', description: 'Optional message_id to quote/reply to.' },
          attachments: { type: 'array', description: 'Optional files to attach.', items: attachmentItem },
        },
        required: ['line'],
      },
    },
    {
      name: 'react',
      description:
        'Add an emoji reaction to a message. Args: line, message_id, emoji. Station derived from ' +
        'the line. Not supported on webhook lines.',
      inputSchema: {
        type: 'object',
        properties: { line: lineProp, message_id: msgIdProp, emoji: { type: 'string', description: 'The emoji to react with.' } },
        required: ['line', 'message_id', 'emoji'],
      },
    },
    {
      name: 'unreact',
      description:
        'Remove an emoji reaction from a message. Args: line, message_id, emoji. Station derived ' +
        'from the line. Not supported on webhook lines.',
      inputSchema: {
        type: 'object',
        properties: { line: lineProp, message_id: msgIdProp, emoji: { type: 'string', description: 'The emoji reaction to remove.' } },
        required: ['line', 'message_id', 'emoji'],
      },
    },
    {
      name: 'edit',
      description:
        'Edit the text of a message you sent. Args: line, message_id, text. Station derived from ' +
        'the line. Not supported on webhook lines. Not supported on xmtp (the daemon returns ' +
        "\"unsupported verb 'edit' on xmtp\"); discord/telegram support it.",
      inputSchema: {
        type: 'object',
        properties: { line: lineProp, message_id: msgIdProp, text: { type: 'string', description: 'The new message text.' } },
        required: ['line', 'message_id', 'text'],
      },
    },
    {
      name: 'delete',
      description:
        'Delete a message you sent. Args: line, message_id. Station derived from the line. Not ' +
        'supported on webhook lines. Not supported on xmtp (the daemon returns "unsupported ' +
        'verb \'delete\' on xmtp"); discord/telegram support it.',
      inputSchema: {
        type: 'object',
        properties: { line: lineProp, message_id: msgIdProp },
        required: ['line', 'message_id'],
      },
    },
    {
      name: 'read',
      description:
        'Read recent message history for a conversation. Args: line, limit?, before?, since?. ' +
        'Station derived from the line. Returns the raw history JSON (shapes differ per station). ' +
        'xmtp maps to a query, discord to a fetch. Not supported on telegram (the daemon returns ' +
        'an unsupported-verb error). Not supported on webhook lines.',
      inputSchema: {
        type: 'object',
        properties: {
          line: lineProp,
          limit: { type: 'number', description: 'Max messages to return.' },
          before: { type: 'string', description: 'Return messages before this message_id.' },
          since: { type: 'string', description: 'Return messages since this timestamp.' },
        },
        required: ['line'],
      },
    },
    {
      name: 'create_channel',
      description:
        'Create a new XMTP group conversation (channel). Args: addresses (required, array of ' +
        'Ethereum 0x addresses to add as members), name (required, the group name), labels? ' +
        '(optional string[] status labels applied after creation via setLabels), account? ' +
        '(default "tony"). Calls the daemon xmtp `newGroup`, then `setLabels` if labels are ' +
        'given. Returns the new metro:// line and convId. This is an xmtp-only operation. ' +
        'NOTE: there is no add-members verb on the daemon, so members must be supplied at ' +
        'creation time.',
      inputSchema: {
        type: 'object',
        properties: {
          addresses: {
            type: 'array',
            description: 'Ethereum 0x addresses to add as group members.',
            items: { type: 'string' },
          },
          name: { type: 'string', description: 'The group/channel name.' },
          labels: { type: 'array', description: 'Optional status labels to apply after creation.', items: { type: 'string' } },
          account: { type: 'string', description: 'XMTP account to create under (default "tony").' },
        },
        required: ['addresses', 'name'],
      },
    },
    {
      name: 'ask',
      description:
        'Ask a question as a poll in an XMTP conversation (mirrors Claude AskUserQuestion). ' +
        'Single-question form: question (required), options? (string[]), header?, multiSelect?, ' +
        'open? (true => free-text answer, options optional). Multi-question form: questions ' +
        '(array of {question, options?, header?, multiSelect?, open?}). Args: line (required) + ' +
        'the above. xmtp-only (the daemon `ask` action). Returns the poll messageId + pollId.',
      inputSchema: {
        type: 'object',
        properties: {
          line: lineProp,
          question: { type: 'string', description: 'The question text (single-question form).' },
          options: { type: 'array', description: 'Answer options for a single question.', items: { type: 'string' } },
          header: { type: 'string', description: 'Optional header/title for the poll.' },
          multiSelect: { type: 'boolean', description: 'Allow selecting multiple options.' },
          open: { type: 'boolean', description: 'Free-text answer (options optional).' },
          questions: {
            type: 'array',
            description: 'Multiple questions (multi-question form). Each is {question, options?, header?, multiSelect?, open?}.',
            items: { type: 'object' },
          },
        },
        required: ['line'],
      },
    },
    {
      name: 'dm',
      description:
        'Open (or reuse) a 1:1 XMTP DM with an Ethereum address. Args: address (required, 0x...), ' +
        'account? (default "tony"). Returns the new metro:// line and convId. xmtp-only ' +
        '(daemon `newDm`). Use this instead of create_channel when there is a single recipient.',
      inputSchema: {
        type: 'object',
        properties: {
          address: { type: 'string', description: 'Recipient Ethereum 0x address.' },
          account: { type: 'string', description: 'XMTP account to DM from (default "tony").' },
        },
        required: ['address'],
      },
    },
    {
      name: 'group_info',
      description:
        'Read an XMTP channel\'s current metadata + membership. Args: line (required). Returns ' +
        '{line, id, account, version (dm|group), name, memberCount, labels, github, preview, ' +
        'members:[{inboxId, address}]}. xmtp-only (daemon `groupInfo`). Use before ' +
        'set_channel_metadata/add_members to see current state.',
      inputSchema: {
        type: 'object',
        properties: { line: lineProp },
        required: ['line'],
      },
    },
    {
      name: 'add_members',
      description:
        'Add members to an existing XMTP group. Args: line (required), addresses? (0x[] ) and/or ' +
        'inboxIds? (string[]); at least one of the two is required. Returns the refreshed ' +
        'group_info plus `added`. xmtp-only (daemon `addMembers`).',
      inputSchema: {
        type: 'object',
        properties: {
          line: lineProp,
          addresses: { type: 'array', description: 'Ethereum 0x addresses to add.', items: { type: 'string' } },
          inboxIds: { type: 'array', description: 'XMTP inboxIds to add.', items: { type: 'string' } },
        },
        required: ['line'],
      },
    },
    {
      name: 'remove_members',
      description:
        'Remove members from an existing XMTP group. Args: line (required), addresses? (0x[]) ' +
        'and/or inboxIds? (string[]); at least one required. Returns the refreshed group_info. ' +
        'xmtp-only (daemon `removeMembers`).',
      inputSchema: {
        type: 'object',
        properties: {
          line: lineProp,
          addresses: { type: 'array', description: 'Ethereum 0x addresses to remove.', items: { type: 'string' } },
          inboxIds: { type: 'array', description: 'XMTP inboxIds to remove.', items: { type: 'string' } },
        },
        required: ['line'],
      },
    },
    {
      name: 'close_channel',
      description:
        'Archive/close an XMTP group (removes members). Args: line (required). xmtp-only ' +
        '(daemon `closeGroup`). Irreversible-ish: members are removed from the group.',
      inputSchema: {
        type: 'object',
        properties: { line: lineProp },
        required: ['line'],
      },
    },
    {
      name: 'list_accounts',
      description:
        'List the configured bot/messaging accounts across all stations (PUBLIC identity only: ' +
        'XMTP inbox/eth addresses, Discord & Telegram bot ids/usernames). No args. Never returns ' +
        'tokens, private keys, or the mnemonic. Reads the daemon /api/accounts view.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'set_channel_metadata',
      description:
        'Update an existing channel\'s metadata. Args: line (required, the metro:// line), and ' +
        'any of labels? (string[]), github? (url), preview? (url), name? (string). Each provided ' +
        'field is applied via its matching daemon verb: labels via setLabels (also carrying ' +
        'name as setName when both are given), github via setGithub, preview via setPreview, ' +
        'and name (when not already applied with labels) via updateChannelMeta. xmtp-only ' +
        '(channel metadata lives on xmtp groups). Returns the updated channel info.',
      inputSchema: {
        type: 'object',
        properties: {
          line: lineProp,
          labels: { type: 'array', description: 'Status labels to set.', items: { type: 'string' } },
          github: { type: 'string', description: 'Linked GitHub URL ("" to clear).' },
          preview: { type: 'string', description: 'Linked preview URL ("" to clear).' },
          name: { type: 'string', description: 'New channel name.' },
        },
        required: ['line'],
      },
    },
  ],
}))

// Tool-result helpers: short text confirmation, JSON payload, and an isError
// result carrying the daemon's reason (so the model sees WHY, not an opaque throw).
const ok = (text: string) => ({ content: [{ type: 'text', text }] })
const okJson = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }] })
const errResult = (text: string) => ({ content: [{ type: 'text', text }], isError: true })

// webhook lines accept no outbound verbs; reject early with a clear message.
const WEBHOOK_REJECT = 'webhook lines do not support outbound messaging (send/reply/react/unreact/edit/delete/read).'

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const name = req.params.name
  const a = (req.params.arguments ?? {}) as Record<string, unknown>

  // create_channel has no `line` yet (it mints one) and is xmtp-only, so it is
  // handled before the line-first guard below.
  if (name === 'create_channel') {
    try {
      const addresses = (a.addresses as unknown[] | undefined)?.map(String).filter(Boolean) ?? []
      const channelName = String(a.name ?? '')
      const labels = (a.labels as unknown[] | undefined)?.map(String).filter(Boolean) ?? []
      const account = a.account ? String(a.account) : undefined
      if (!addresses.length) return errResult('create_channel requires a non-empty `addresses` array')
      if (!channelName) return errResult('create_channel requires `name`')
      const groupArgs: Record<string, unknown> = { addresses, name: channelName }
      if (account) groupArgs.account = account
      const created = await metroCall('xmtp', 'newGroup', groupArgs) as { line?: string; id?: string; account?: string } | null
      const newLine = created?.line ?? ''
      let labelResult: unknown
      if (labels.length && newLine) {
        labelResult = await metroCall('xmtp', 'setLabels', { line: newLine, labels })
      }
      return okJson({ line: newLine, convId: created?.id, account: created?.account, labels: labels.length ? labelResult : undefined })
    } catch (e) {
      if (e instanceof MetroCallError) return errResult(e.detail)
      return errResult(`metro create_channel failed: ${String(e)}`)
    }
  }

  // dm mints a new line from an address (xmtp-only); handle before the line guard.
  if (name === 'dm') {
    try {
      const address = String(a.address ?? '')
      if (!address) return errResult('dm requires `address`')
      const dmArgs: Record<string, unknown> = { address }
      if (a.account) dmArgs.account = String(a.account)
      const created = await metroCall('xmtp', 'newDm', dmArgs)
      return okJson(created)
    } catch (e) {
      if (e instanceof MetroCallError) return errResult(e.detail)
      return errResult(`metro dm failed: ${String(e)}`)
    }
  }

  // list_accounts: the in-process accounts view (all stations, public ids only).
  if (name === 'list_accounts') {
    try {
      return okJson({ accounts: await gatherAccounts() })
    } catch (e) {
      return errResult(`metro list_accounts failed: ${String(e)}`)
    }
  }

  const line = String(a.line ?? '')
  if (!line) return errResult(`${name} requires \`line\``)
  const train = trainOf(line)
  if (train === 'webhook') return errResult(WEBHOOK_REJECT)

  if (name === 'set_channel_metadata') {
    try {
      const labels = a.labels as unknown[] | undefined
      const github = a.github as string | undefined
      const preview = a.preview as string | undefined
      const metaName = a.name as string | undefined
      let nameApplied = false
      let info: unknown
      // labels via setLabels (carry name as setName so both land in one mutation).
      if (Array.isArray(labels)) {
        const setArgs: Record<string, unknown> = { line, labels: labels.map(String) }
        if (typeof metaName === 'string' && metaName) { setArgs.setName = metaName; nameApplied = true }
        info = await metroCall(train, 'setLabels', setArgs)
      }
      if (typeof github === 'string') info = await metroCall(train, 'setGithub', { line, url: github })
      if (typeof preview === 'string') info = await metroCall(train, 'setPreview', { line, preview })
      // name not yet applied via setLabels -> updateChannelMeta.
      if (typeof metaName === 'string' && metaName && !nameApplied) {
        info = await metroCall(train, 'updateChannelMeta', { line, name: metaName })
      }
      if (info === undefined) return errResult('set_channel_metadata requires at least one of `labels`, `github`, `preview`, `name`')
      return okJson(info)
    } catch (e) {
      if (e instanceof MetroCallError) return errResult(e.detail)
      return errResult(`metro set_channel_metadata failed: ${String(e)}`)
    }
  }

  try {
    switch (name) {
      case 'send': {
        const text = a.text as string | undefined
        const replyTo = a.reply_to as string | undefined
        const atts = (a.attachments as CanonicalAttachment[] | undefined)?.filter(x => x && (x.path || x.url)) ?? []
        const sent: string[] = []
        if (train === 'xmtp') {
          // xmtp `send` ignores canonical attachments -> dispatch natively.
          if (text) { await metroSend(line, text, replyTo); sent.push('text') }
          sent.push(...await xmtpSendAttachments(line, atts))
        } else {
          // telegram/discord: canonical attachments ride the `send` action; the
          // daemon normalize layer turns them into native multipart inputs.
          if (!text && !atts.length) return errResult('send requires `text` or `attachments`')
          const args: Record<string, unknown> = { line }
          if (text) args.text = text
          if (replyTo) args.replyTo = replyTo
          if (atts.length) args.attachments = atts.map(toCanonical)
          await metroCall(train, 'send', args)
          if (text) sent.push('text')
          if (atts.length) sent.push(`${atts.length} attachment(s)`)
        }
        if (!sent.length) return errResult('send requires `text` or `attachments`')
        return ok(`sent: ${sent.join(', ')}`)
      }
      case 'reply': {
        const messageId = String(a.message_id ?? '')
        const text = String(a.text ?? '')
        if (!messageId || !text) return errResult('reply requires `message_id` and `text`')
        await metroCall(train, 'reply', { line, replyTo: messageId, text })
        return ok('replied')
      }
      case 'react': {
        const messageId = String(a.message_id ?? '')
        const emoji = String(a.emoji ?? '')
        if (!messageId || !emoji) return errResult('react requires `message_id` and `emoji`')
        await metroCall(train, 'react', { line, messageId, emoji })
        return ok('reacted')
      }
      case 'unreact': {
        const messageId = String(a.message_id ?? '')
        const emoji = String(a.emoji ?? '')
        if (!messageId || !emoji) return errResult('unreact requires `message_id` and `emoji`')
        await metroCall(train, 'unreact', { line, messageId, emoji })
        return ok('reaction removed')
      }
      case 'edit': {
        const messageId = String(a.message_id ?? '')
        const text = String(a.text ?? '')
        if (!messageId || !text) return errResult('edit requires `message_id` and `text`')
        await metroCall(train, 'edit', { line, messageId, text })
        return ok('edited')
      }
      case 'delete': {
        const messageId = String(a.message_id ?? '')
        if (!messageId) return errResult('delete requires `message_id`')
        await metroCall(train, 'delete', { line, messageId })
        return ok('deleted')
      }
      case 'read': {
        const args: Record<string, unknown> = { line }
        if (typeof a.limit === 'number') args.limit = a.limit
        if (a.before) args.before = String(a.before)
        if (a.since) args.since = String(a.since)
        const result = await metroCall(train, 'read', args)
        return okJson(result)
      }
      case 'ask': {
        // Pass the poll args through to the xmtp `ask` action verbatim (it accepts
        // single {question, options?, header?, multiSelect?, open?} or {questions:[…]}).
        const args: Record<string, unknown> = { line }
        for (const k of ['question', 'options', 'header', 'multiSelect', 'open', 'questions'] as const) {
          if (a[k] !== undefined) args[k] = a[k]
        }
        if (a.question === undefined && a.questions === undefined) {
          return errResult('ask requires `question` (single) or `questions` (multi)')
        }
        const result = await metroCall(train, 'ask', args)
        return okJson(result)
      }
      case 'group_info': {
        const result = await metroCall(train, 'groupInfo', { line })
        return okJson(result)
      }
      case 'close_channel': {
        const result = await metroCall(train, 'closeGroup', { line })
        return okJson(result)
      }
      case 'add_members':
      case 'remove_members': {
        const addresses = (a.addresses as unknown[] | undefined)?.map(String).filter(Boolean) ?? []
        const inboxIds = (a.inboxIds as unknown[] | undefined)?.map(String).filter(Boolean) ?? []
        if (!addresses.length && !inboxIds.length) {
          return errResult(`${name} requires \`addresses\` or \`inboxIds\``)
        }
        const args: Record<string, unknown> = { line }
        if (addresses.length) args.addresses = addresses
        if (inboxIds.length) args.inboxIds = inboxIds
        const action = name === 'add_members' ? 'addMembers' : 'removeMembers'
        const result = await metroCall(train, action, args)
        return okJson(result)
      }
      default:
        return errResult(`unknown tool: ${name}`)
    }
  } catch (e) {
    // Surface the daemon's reason (e.g. "unsupported verb 'edit' on xmtp",
    // telegram read unsupported, or the xmtp attachment size cap) as the tool
    // result with isError semantics so the model can read and explain it.
    if (e instanceof MetroCallError) return errResult(e.detail)
    return errResult(`metro ${name} failed: ${String(e)}`)
  }
})

// --- Permission relay -------------------------------------------------------
// Map request_id -> the line to send the verdict prompt to (last-seen inbound).
let lastLine: string | undefined
const pending = new Map<string, string>()

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})

type PermissionRequest = z.infer<typeof PermissionRequestSchema>
// Cast sidesteps a deep-recursive generic in the SDK's setNotificationHandler
// type; runtime validation is still done by the zod schema above.
mcp.setNotificationHandler(PermissionRequestSchema as never, async (n: PermissionRequest) => {
  const { params } = n
  const line = lastLine
  if (!line) { log('permission_request but no known line to relay to', params.request_id); return }
  pending.set(params.request_id, line)
  const body = `Claude wants to run ${params.tool_name}: ${params.description}\n` +
    (params.input_preview ? `\n${params.input_preview}\n` : '') +
    `\nReply "yes ${params.request_id}" or "no ${params.request_id}"`
  try { await metroSend(line, body) } catch (e) { log('relay send failed', e) }
})

// --- Inbound: sender allowlist ----------------------------------------------
const senderAllowed = (from: string) => {
  const allowlist = getAllowlist()
  if (allowlist.includes('*')) return true
  const f = (from ?? '').toLowerCase()
  // match full URI or trailing id segment against the allowlist
  const id = f.split('/').pop() ?? f
  return allowlist.some(a => a === f || a === id)
}

// verdict format: "yes abcde" / "no abcde" (5 letters, no 'l'); /i for autocorrect
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

// Short, human-friendly id for the reacted-to message in the note.
const shortId = (id: string) => (id.length > 10 ? `${id.slice(0, 6)}…` : id)

// --- Inbound media -----------------------------------------------------------
// Inbound attachments arrive as TWO events: (1) the msg event carries
// `payload.attachments[]` (for XMTP the urls are ENCRYPTED bytes, unusable
// directly); (2) the daemon fetches/decrypts each blob asynchronously and emits
// a follow-up `attachmentSaved` event (one per index) carrying the absolute
// on-disk path. That follow-up has no real sender `from` (it originates from the
// daemon, e.g. SELF_URI), so it can't pass the per-event allowlist.
//
// We correlate the two: buffer the (allowlisted) source msg keyed by its
// top-level event `id` (== attachmentSaved.attachmentFor) so the saved-file
// surfacing quotes the real sender + caption. `allowedLines` is a fallback gate
// (a line an allowed sender already drives) for any orphan attachmentSaved.
const allowedLines = new Set<string>()

// --- Inbound dedupe ----------------------------------------------------------
// The daemon runs multiple booted accounts (e.g. tony + codex) that sit in the
// SAME channels, so ONE real inbound message is written to history.jsonl ONCE
// PER ACCOUNT: distinct top-level event `id`s, but identical station +
// messageId + channel, differing only in the account segment of the `line`
// (metro://discord/tony/<chan> vs metro://discord/codex/<chan>). The shared
// /api/tail stream replays every entry, so without dedupe the model sees each
// message twice (verified in history.jsonl: same messageId, two `line`s).
//
// We dedupe on a stable identity that IGNORES the account segment: station +
// the account-stripped line (so different channels/DMs stay distinct) + the
// per-event kind + the station-native message id. Text is NOT part of the key
// (same text in different channels must stay distinct; and a message vs its
// later react carry the same messageId but a different kind, so both surface).
// A genuinely distinct message (new messageId) or a true per-account DM
// (different channel segment) yields a different key and is never dropped.
//
// Bounded short-TTL seen-set: the two duplicate entries arrive back-to-back, so
// a small window suffices; entries self-expire and the set is capped to avoid
// unbounded growth on this long-lived process.
const DEDUPE_TTL_MS = 30_000
const DEDUPE_MAX = 2_000
const seenEvents = new Map<string, number>()

// Strip the account segment from a line: metro://<station>/<account>/<rest>
// -> metro://<station>/<rest>. Lines without an account segment pass through.
const accountStrippedLine = (line: string): string => {
  const parts = line.split('/')
  // ['metro:', '', '<station>', '<account>', '<rest>...']
  if (parts.length < 5) return line
  return [parts[0], parts[1], parts[2], ...parts.slice(4)].join('/')
}

// True if this event was already surfaced (and should be skipped as a per-account dupe).
const isDuplicateEvent = (station: string, line: string, kind: string, messageId: string): boolean => {
  // No station-native id to key on -> can't safely dedupe; let it through.
  if (!messageId) return false
  const key = `${station} ${accountStrippedLine(line)} ${kind} ${messageId}`
  const now = Date.now()
  // Opportunistic prune of expired entries when the cap is hit (amortised, cheap).
  if (seenEvents.size >= DEDUPE_MAX) {
    for (const [k, t] of seenEvents) { if (now - t > DEDUPE_TTL_MS) seenEvents.delete(k) }
  }
  const prev = seenEvents.get(key)
  if (prev !== undefined && now - prev < DEDUPE_TTL_MS) return true
  seenEvents.set(key, now)
  return false
}

const ATTACH_TIMEOUT_MS = 15_000
// Gate base64/Read inlining at 4MB to stay clear of the ~5MB channels/API cap.
const MAX_INLINE_BYTES = 4 * 1024 * 1024

type PendingAtt = { kind?: string; name?: string }
type PendingMsg = {
  line: string
  from: string
  station: string
  text: string
  messageId: string
  lineName: string
  attachments: PendingAtt[]
  saved: Set<number>
  timer: ReturnType<typeof setTimeout>
}
const pendingAttachments = new Map<string, PendingMsg>()

// Media payload as projected by the xmtp/telegram/discord trains (attachmentSaved).
type SavedMedia = {
  contentType?: string
  attachmentFor?: string
  attachmentPath?: string
  localPath?: string
  url?: string
  mime?: string
  name?: string
  index?: number
}

const mediaKind = (mime?: string, name?: string): string => {
  const m = (mime ?? '').toLowerCase()
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  if (/\.(png|jpe?g|gif|webp|heic)$/i.test(name ?? '')) return 'image'
  if (/\.(mp4|mov|webm|m4v)$/i.test(name ?? '')) return 'video'
  if (/\.(m4a|mp3|ogg|wav)$/i.test(name ?? '')) return 'audio'
  return 'file'
}

// Surface a saved inbound attachment to the session.
//
// CONTENT SHAPE DECISION: the Channels notification `content` field is typed as
// `string` (channels-reference, "Notification format": content | string | "The
// event body. Delivered as the body of the <channel> tag."). It does NOT accept
// a multimodal content-block array, so an {type:'image',source:{base64}} block
// is not deliverable. We therefore take the documented fallback: a text note +
// the absolute on-disk path (the daemon already decrypted the bytes there). The
// session reads images visually and opens other files via the Read tool on that
// path. We still size-gate at 4MB and steer Claude away from inlining huge files.
async function surfaceMedia(ctx: { line: string; from: string; station: string }, p: SavedMedia) {
  const path = p.attachmentPath ?? p.localPath
  if (!path) return
  const kind = mediaKind(p.mime, p.name)
  const name = p.name ?? path.split('/').pop() ?? 'attachment'
  let size = 0
  try { size = (await stat(path)).size } catch { /* not yet on disk / unreadable */ }
  const tooBig = size > MAX_INLINE_BYTES
  const sizeNote = size ? ` (${(size / 1024 / 1024).toFixed(2)} MB)` : ''
  const content =
    `[${kind} attachment received: ${name}${p.mime ? `, ${p.mime}` : ''}${sizeNote}]\n` +
    `Saved locally at: ${path}\n` +
    (p.url ? `Public URL: ${p.url}\n` : '') +
    (tooBig
      ? 'Large file - inspect on disk only as needed (do not inline).'
      : 'Use the Read tool on that absolute path to view/inspect it.')
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content,
      meta: {
        line: ctx.line,
        from: ctx.from,
        station: ctx.station,
        kind,
        mime: p.mime ?? '',
        name,
        local_path: path,
      },
    },
  })
}

// Flush a buffered msg whose attachments never produced an attachmentSaved
// (fetch/decrypt failed or timed out): text-only fallback naming the file(s).
async function flushPendingFallback(id: string) {
  const e = pendingAttachments.get(id)
  if (!e) return
  pendingAttachments.delete(id)
  const missing = e.attachments.filter((_, i) => !e.saved.has(i))
  if (!missing.length) return
  const names = missing.map(a => a.name ?? a.kind ?? 'attachment').join(', ')
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content:
        (e.text ? `${e.text}\n` : '') +
        `[attachment(s) could not be fetched in time: ${names}]`,
      meta: {
        line: e.line, from: e.from, station: e.station,
        message_id: e.messageId, line_name: e.lineName,
      },
    },
  })
}

async function handleEvent(ev: Record<string, unknown>) {
  // Daemon-side follow-up: an inbound attachment was fetched/decrypted and
  // written to disk. Handle BEFORE the normal sender/allowlist guard, because
  // this event's `from` is the daemon self-uri (not the real sender) and would
  // be dropped. Gate instead via the correlated source msg (allowlisted) or, as
  // a fallback, the line an allowed sender already drives.
  const payload = ev.payload as SavedMedia | undefined
  if (payload?.contentType === 'attachmentSaved') {
    const line = String(ev.line ?? '')
    const forId = String(payload.attachmentFor ?? '')
    const buf = forId ? pendingAttachments.get(forId) : undefined
    if (buf) {
      const idx = typeof payload.index === 'number' ? payload.index : 0
      buf.saved.add(idx)
      await surfaceMedia({ line: buf.line, from: buf.from, station: buf.station }, payload)
      if (buf.saved.size >= buf.attachments.length) {
        clearTimeout(buf.timer)
        pendingAttachments.delete(forId)
      }
    } else if (line && allowedLines.has(line)) {
      await surfaceMedia(
        { line, from: 'metro://attachment', station: String(ev.station ?? 'xmtp') },
        payload,
      )
    }
    return
  }

  // Forward chat messages and emoji reactions; drop edits/deletes/system/etc.
  const evType = ev.event ? (ev.event as { type?: string }).type : 'msg'
  if (evType !== 'msg' && evType !== 'react') return
  const isReact = evType === 'react'
  const station = String(ev.station ?? '')
  if (station === 'webhook' || !getStations().has(station)) return
  const from = String(ev.from ?? '')
  // outbound echoes have a local `from` (metro://claude|user|...); only act on real inbound
  if (from.startsWith('metro://claude') || from === 'metro://user' || !from.startsWith('metro://')) return
  if (!senderAllowed(from)) { log('drop: sender not allowed', from); return }

  const line = String(ev.line ?? '')
  const text = String(ev.text ?? '')
  // Per-account dedupe: the daemon writes the same inbound message once per
  // booted account (tony/codex) that shares the channel, so /api/tail replays
  // it twice with only the account segment of `line` differing. Drop the second
  // copy, keyed on station + account-stripped line + kind + messageId. Done here
  // (after the allowlist guard, before any surfacing/buffering) so it covers
  // plain text, reactions, AND attachment-carrying msgs uniformly.
  if (isDuplicateEvent(station, line, evType ?? 'msg', String(ev.messageId ?? ''))) {
    log('drop: duplicate (per-account) event', evType, station, String(ev.messageId ?? ''))
    return
  }
  lastLine = line
  // Remember this conversation so the daemon's follow-up attachmentSaved event
  // (which carries no real sender) can be gated/surfaced on the same line.
  if (line) allowedLines.add(line)

  // If this (allowlisted) msg carries attachments, buffer its context keyed by
  // the top-level event id so the follow-up attachmentSaved events can correlate
  // per index and quote the real sender + caption. 15s self-destruct fallback.
  const atts = (ev.payload as { attachments?: PendingAtt[] } | undefined)?.attachments
  if (Array.isArray(atts) && atts.length) {
    const id = String(ev.id ?? '')
    if (id) {
      const existing = pendingAttachments.get(id)
      if (existing) clearTimeout(existing.timer)
      pendingAttachments.set(id, {
        line, from, station, text,
        messageId: String(ev.messageId ?? ''),
        lineName: String(ev.lineName ?? ''),
        attachments: atts.map(a => ({ kind: a?.kind, name: a?.name })),
        saved: new Set<number>(),
        timer: setTimeout(() => { void flushPendingFallback(id) }, ATTACH_TIMEOUT_MS),
      })
    }
    // Don't also forward the placeholder text ("[image: metro-pending-...]") as a
    // normal chat turn - the surfaced file (or fallback) carries the content.
    return
  }

  if (isReact) {
    // react event schema (HistoryEntry.event): { type:'react', emoji?, targetId? }.
    // Per-station shape differs (verified against live history.jsonl):
    //  - xmtp/telegram: emoji is a plain string; targetId is absent.
    //  - discord: emoji is a discord.js object {name,reaction,identifier,...};
    //    targetId is absent.
    // The reacted-to message id is always carried top-level as `messageId` (the
    // dispatcher does not fold it into `event.targetId`), so prefer that.
    const re = ev.event as { emoji?: unknown; targetId?: string }
    const rawEmoji = re.emoji
    const emoji = typeof rawEmoji === 'string'
      ? rawEmoji
      : String((rawEmoji as { name?: string; reaction?: string } | undefined)?.name
        ?? (rawEmoji as { reaction?: string } | undefined)?.reaction ?? '')
    const target = re.targetId ?? String(ev.messageId ?? '')
    // Only xmtp distinguishes removals (payload.removed / "(removed)" in text).
    const removed = (ev.payload as { removed?: boolean } | undefined)?.removed === true ||
      / \(removed\)\]?$/.test(text)
    const content = removed
      ? `${emoji || 'reaction'} removed from message ${shortId(target)}`.trim()
      : `${emoji || 'reacted'} reacted to message ${shortId(target)}`.trim()
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content,
        meta: {
          line,
          from,
          station,
          message_id: String(ev.messageId ?? ''),
          line_name: String(ev.lineName ?? ''),
          reaction: emoji,
          target_id: target,
        },
      },
    })
    return
  }

  // intercept permission verdicts before forwarding as chat (msg text only)
  const m = PERMISSION_REPLY_RE.exec(text)
  if (m && pending.size) {
    const id = m[2].toLowerCase()
    if (pending.has(id)) {
      pending.delete(id)
      await mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id: id, behavior: m[1].toLowerCase().startsWith('y') ? 'allow' : 'deny' },
      })
      return
    }
  }

  await mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: text,
      meta: {
        line,
        from,
        station,
        message_id: String(ev.messageId ?? ''),
        line_name: String(ev.lineName ?? ''),
      },
    },
  })
}

// --- In-process wiring -------------------------------------------------------
// Build the /mcp request handler + the inbound pump. The daemon calls this once
// (dispatcher.ts), mounts `httpHandler` at /mcp on its HTTP server, and calls
// `startInbound()` to begin driving channel push from the history tail.
export async function createMetroMcp(): Promise<{
  httpHandler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  startInbound: () => void
}> {
  // Stateful streamable HTTP: a session (mcp-session-id) spans the connection so
  // server→client notifications (channel push) can ride the standalone GET /mcp
  // SSE stream. One transport serves one client; a fresh `initialize` mints a new
  // session (and reconnects the single server), so a reconnecting client is never
  // rejected by an already-initialized transport.
  let transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })
  await mcp.connect(transport)
  const reconnect = async (): Promise<void> => {
    try { await transport.close() } catch { /* ignore */ }
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })
    await mcp.connect(transport)
  }
  const isInitialize = (b: unknown): boolean =>
    !!b && typeof b === 'object' && (b as { method?: string }).method === 'initialize'
  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const raw = Buffer.concat(chunks).toString('utf8')
    try { return raw ? JSON.parse(raw) : undefined } catch { return undefined }
  }

  // Optional bearer gate for /mcp. The daemon↔MCP link is in-process now, so no
  // METRO_MONITOR_TOKEN is involved — this only gates external MCP clients.
  const httpToken = process.env.METRO_MCP_HTTP_TOKEN || ''
  const httpHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (httpToken) {
      const h = ([] as string[]).concat(req.headers['authorization'] ?? [])[0] ?? ''
      if (!(h.startsWith('Bearer ') && h.slice(7) === httpToken)) {
        res.writeHead(401).end('unauthorized'); return
      }
    }
    // POST carries the JSON-RPC body; read it so we can spot a fresh `initialize`
    // (→ new session) and hand the parsed body to the transport. GET/DELETE drive
    // the SSE stream / teardown and have no body.
    if (req.method === 'POST') {
      const body = await readBody(req)
      if (isInitialize(body)) await reconnect()
      await transport.handleRequest(req, res, body)
      return
    }
    await transport.handleRequest(req, res)
  }

  // Inbound: follow the in-process history journal from EOF (== the old SSE
  // `since=tail`), driving handleEvent with the SAME entries /api/tail streamed.
  // No station filter at the source — getStations() in handleEvent is the dynamic
  // gate, and webhook is hard-dropped there (flood/crash risk).
  const startInbound = (): void => {
    const opts: TailOpts = { mode: 'all', self: null }
    const onEntry = (e: HistoryEntry): void => {
      void handleEvent(e as unknown as Record<string, unknown>).catch(err => log('event err', err))
    }
    const offset = drainTail(historySize(), opts, onEntry) // start at EOF: new events only
    followTail(offset, opts, onEntry, 1_000)
    log('inbound: following history tail (mode=all)')
  }

  return { httpHandler, startInbound }
}
