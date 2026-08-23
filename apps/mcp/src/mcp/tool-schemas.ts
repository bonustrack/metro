const lineProp = {
  type: 'string',
  description:
    'The metro:// line (from the inbound <channel> tag). The station is derived from it.',
} as const;
const msgIdProp = {
  type: 'string',
  description: 'The target message_id.',
} as const;

const attachmentItem = {
  type: 'object',
  description:
    'A file to attach. Provide EXACTLY ONE source; naming two is an error and so is naming ' +
    'none. Which one to use: `upload` for any real file on your own machine, including a ' +
    'confidential one (call `create_upload` first, push the bytes over HTTP, then name the ' +
    'id here); `data` ONLY for a tiny file, a few KB at most, because the base64 has to be ' +
    'written out verbatim in this tool call and long base64 gets corrupted in the writing; ' +
    '`url` when the file is ALREADY published somewhere the daemon can fetch it; `path` ONLY ' +
    'for a file that is already sitting on the daemon host, which is almost never your ' +
    'machine.',
  properties: {
    upload: {
      type: 'string',
      description:
        'The `upload_id` of a file already pushed to metro over HTTP (`create_upload` mints ' +
        'the slot and the one-line command; the bytes never pass through this conversation). ' +
        'THIS IS THE ROUTE FOR ANYTHING REAL: it takes files up to 64 MiB, works for a file on ' +
        'your own machine, and publishes nothing. The upload belongs to your agent, expires ' +
        '30 minutes after it is created, and no other agent can name it.',
    },
    data: {
      type: 'string',
      description:
        'Base64-encoded file bytes, inline in this call. ONLY FOR TINY FILES. The hard cap is ' +
        '8 MiB decoded, but the real ceiling is far lower and is not enforced by the daemon: ' +
        'this base64 has to be emitted verbatim as part of the tool call, and past roughly ' +
        '10 KB (~13 KB of base64) it comes out corrupted, so the file arrives silently ' +
        'damaged or fails to decode. Use `upload` instead for anything bigger. A ' +
        '`data:<mime>;base64,` prefix is accepted and supplies the mime when `mime` is ' +
        'omitted. Stations impose their own, lower limits (xmtp refuses non-image files over ' +
        '~190 KiB).',
    },
    url: {
      type: 'string',
      description:
        'http(s) URL fetched BY THE DAEMON, so it must already be publicly reachable from the ' +
        'daemon host. Right when the file is already published; never for anything ' +
        'confidential, because it has to be public for this to work at all. Use `upload` for ' +
        'a confidential file.',
    },
    path: {
      type: 'string',
      description:
        'Absolute path resolved ON THE DAEMON HOST, which is a different machine from yours. ' +
        'A path on your own disk does NOT resolve here and is refused, however local it ' +
        'looks. Use `upload` for a file on your machine.',
    },
    mime: {
      type: 'string',
      description: 'MIME type (guessed from the name/extension if omitted).',
    },
    name: {
      type: 'string',
      description:
        'Filename to present (defaults to the basename, or to the name given at upload time).',
    },
  },
} as const;

const CREATE_UPLOAD_TOOL = {
  name: 'create_upload',
  description:
    'Reserve a slot to push a file to metro over HTTP so you can attach it with `send`. Use ' +
    'this for any file that actually matters: it is the only attachment route that carries a ' +
    'file from YOUR machine without publishing it and without the bytes passing through this ' +
    'conversation. Args: name? (the filename to present), mime?. Returns `upload_id`, a ' +
    'single-use `upload_url` and a ready-to-run `curl` line. ONE STEP NEEDS A SHELL: run that ' +
    'command (or any HTTP client) to push the bytes; there is no way to move a local file to ' +
    'the daemon over MCP alone, because anything in an MCP call has to be written out by the ' +
    'model first. If you have no shell, hand the single command to a subagent that does and ' +
    'keep the `upload_id` -- the slot belongs to this metro agent, not to whoever runs the ' +
    'command. Then: send({line, attachments:[{upload:"<upload_id>"}]}). Up to 64 MiB, expires ' +
    '30 minutes after it is created, and no other agent can reference it.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Filename to present to the recipient (e.g. `report.pdf`).',
      },
      mime: {
        type: 'string',
        description: 'MIME type (guessed from the name/extension if omitted).',
      },
    },
  },
};

export const COMMON_TOOLS = [
  {
    name: 'reply',
    description:
      'Reply to a specific message in a Metro conversation (text quotes the target). Args: ' +
      "line, message_id, text. The station is derived from the line. Returns the daemon's " +
      'reason if the station does not support replies.',
    inputSchema: {
      type: 'object',
      properties: {
        line: lineProp,
        message_id: msgIdProp,
        text: { type: 'string', description: 'The reply text.' },
      },
      required: ['line', 'message_id', 'text'],
    },
  },
  {
    name: 'send',
    description:
      'Send a message (and/or media) to a Metro conversation. Args: line, text?, reply_to?, ' +
      'attachments?. The station is derived from the line. Each attachment names EXACTLY ONE ' +
      'source, and the choice matters: `upload` (an `upload_id` from `create_upload`, the ' +
      'route for any real file on your own machine, confidential or not, up to 64 MiB); ' +
      '`data` (base64 inline -- TINY FILES ONLY, a few KB, because the base64 has to be ' +
      'written out verbatim in the call and longer than that it corrupts); `url` (the daemon ' +
      'fetches it, so the file must already be public); `path` (resolved on the DAEMON host, ' +
      'which is not your machine). At least one of text/attachments is required. ' +
      'The success line names each attachment the station actually delivered; a station that ' +
      'cannot carry a file errors instead of reporting success.',
    inputSchema: {
      type: 'object',
      properties: {
        line: lineProp,
        text: {
          type: 'string',
          description: 'The message text (optional if sending only media).',
        },
        reply_to: {
          type: 'string',
          description: 'Optional message_id to quote/reply to.',
        },
        attachments: {
          type: 'array',
          description: 'Optional files to attach.',
          items: attachmentItem,
        },
      },
      required: ['line'],
    },
  },
  {
    name: 'react',
    description:
      'Add an emoji reaction to a message. Args: line, message_id, emoji. The station is derived from the line.',
    inputSchema: {
      type: 'object',
      properties: {
        line: lineProp,
        message_id: msgIdProp,
        emoji: { type: 'string', description: 'The emoji to react with.' },
      },
      required: ['line', 'message_id', 'emoji'],
    },
  },
  {
    name: 'unreact',
    description:
      'Remove an emoji reaction from a message. Args: line, message_id, emoji. The station is derived from the line.',
    inputSchema: {
      type: 'object',
      properties: {
        line: lineProp,
        message_id: msgIdProp,
        emoji: {
          type: 'string',
          description: 'The emoji reaction to remove.',
        },
      },
      required: ['line', 'message_id', 'emoji'],
    },
  },
  {
    name: 'edit',
    description:
      'Edit the text of a message you sent. Args: line, message_id, text. The station is ' +
      "derived from the line. Returns the daemon's reason if the station does not support edits.",
    inputSchema: {
      type: 'object',
      properties: {
        line: lineProp,
        message_id: msgIdProp,
        text: { type: 'string', description: 'The new message text.' },
      },
      required: ['line', 'message_id', 'text'],
    },
  },
  {
    name: 'delete',
    description:
      'Delete a message you sent. Args: line, message_id. The station is derived from the line. ' +
      "Returns the daemon's reason if the station does not support deletes.",
    inputSchema: {
      type: 'object',
      properties: { line: lineProp, message_id: msgIdProp },
      required: ['line', 'message_id'],
    },
  },
  {
    name: 'read',
    description:
      'Read recent message history for a conversation. Args: line, limit?, before?, since?. The ' +
      'station is derived from the line. Returns the raw history JSON (shapes differ per ' +
      "station), or the daemon's reason if the station does not support reads.",
    inputSchema: {
      type: 'object',
      properties: {
        line: lineProp,
        limit: { type: 'number', description: 'Max messages to return.' },
        before: {
          type: 'string',
          description: 'Return messages before this message_id.',
        },
        since: {
          type: 'string',
          description: 'Return messages since this timestamp.',
        },
      },
      required: ['line'],
    },
  },
  {
    name: 'list_members',
    description:
      'List the members of a Metro group/channel in a station-agnostic shape. Args: line, ' +
      'limit?. The station is derived from the line. Returns {line, station, memberCount, ' +
      'members:[{id, name?, display_name?, address?, roles?, is_admin?, is_bot?}], capability:' +
      '{supported, complete, reason?, total?}}. Each station fills the fields it has (xmtp: id=' +
      'inboxId + address; discord-bot: id + username/nick + roles + is_bot; telegram-bot/telegram: ' +
      'id + username/first_name). Never throws on "not supported": stations that cannot ' +
      'enumerate (e.g. the Telegram Bot API) return an empty or partial list with a reason in ' +
      '`capability`. Check `capability.complete` before assuming the roster is exhaustive.',
    inputSchema: {
      type: 'object',
      properties: {
        line: lineProp,
        limit: {
          type: 'number',
          description: 'Max members to return (best-effort; capped per station).',
        },
      },
      required: ['line'],
    },
  },
  {
    name: 'create_group',
    description:
      'Create a new group/channel on a station and add members, in a station-agnostic shape. ' +
      'Args: station (required, xmtp|telegram|discord-bot|telegram-bot), name (required), members? ' +
      '(string[]; xmtp: 0x address or inboxId, telegram: @username or user id, discord-bot: ' +
      'user id), account? (which station account), parent? (discord-bot only: the metro:// line of ' +
      'the channel to open the thread under). Returns {op, line (the NEW group line), station, ' +
      'supported, reason?, id?, name?, members:[{id, status: added|invited|removed|failed, ' +
      'reason?}], inviteLink?}. Never throws on "not supported": stations that lack the op ' +
      '(e.g. the Telegram Bot API) return {supported:false, reason}. Telegram direct-add is ' +
      'limited to mutual contacts / permissive privacy — members who cannot be added come back ' +
      'as status "invited" and an `inviteLink` is returned to share with them.',
    inputSchema: {
      type: 'object',
      properties: {
        station: {
          type: 'string',
          description: 'The station to create the group on (xmtp|telegram|discord-bot).',
        },
        name: { type: 'string', description: 'The group/channel name.' },
        members: {
          type: 'array',
          description: 'Members to seed the group with (station-specific identifiers).',
          items: { type: 'string' },
        },
        account: {
          type: 'string',
          description: 'Station account to create under (defaults to the station default).',
        },
        parent: {
          type: 'string',
          description:
            'Discord only: the metro:// line of the channel to create the thread under.',
        },
      },
      required: ['station', 'name'],
    },
  },
  {
    name: 'add_members',
    description:
      'Add members to an existing Metro group, in a station-agnostic shape. Args: line ' +
      '(required), members? (string[]; station-specific identifiers). xmtp also accepts ' +
      'addresses? (0x[]) and inboxIds? (string[]) for backward compatibility. The station is ' +
      'derived from the line. Returns {op, line, station, supported, reason?, members:[{id, ' +
      'status, reason?}], inviteLink?}. Never throws on "not supported". On Telegram, members ' +
      'who cannot be direct-added come back status "invited" with an `inviteLink`.',
    inputSchema: {
      type: 'object',
      properties: {
        line: lineProp,
        members: {
          type: 'array',
          description: 'Members to add (station-specific identifiers).',
          items: { type: 'string' },
        },
        addresses: {
          type: 'array',
          description: 'xmtp only: Ethereum 0x addresses to add.',
          items: { type: 'string' },
        },
        inboxIds: {
          type: 'array',
          description: 'xmtp only: XMTP inboxIds to add.',
          items: { type: 'string' },
        },
      },
      required: ['line'],
    },
  },
  {
    name: 'remove_members',
    description:
      'Remove members from an existing Metro group, in a station-agnostic shape. Args: line ' +
      '(required), members? (string[]). xmtp also accepts addresses?/inboxIds? for backward ' +
      'compatibility. The station is derived from the line. Returns {op, line, station, ' +
      'supported, reason?, members:[{id, status, reason?}]}. Never throws on "not supported".',
    inputSchema: {
      type: 'object',
      properties: {
        line: lineProp,
        members: {
          type: 'array',
          description: 'Members to remove (station-specific identifiers).',
          items: { type: 'string' },
        },
        addresses: {
          type: 'array',
          description: 'xmtp only: Ethereum 0x addresses to remove.',
          items: { type: 'string' },
        },
        inboxIds: {
          type: 'array',
          description: 'xmtp only: XMTP inboxIds to remove.',
          items: { type: 'string' },
        },
      },
      required: ['line'],
    },
  },
  {
    name: 'export_invite',
    description:
      'Get a join/invite link for a Metro group, for platforms where direct-add is not always ' +
      'permitted. Args: line (required). The station is derived from the line. Returns {op, ' +
      'line, station, supported, reason?, inviteLink?}. Only telegram supports this today; ' +
      'other stations return {supported:false, reason}. Never throws on "not supported".',
    inputSchema: {
      type: 'object',
      properties: { line: lineProp },
      required: ['line'],
    },
  },
  CREATE_UPLOAD_TOOL,
];

export const LIST_ACCOUNTS_TOOL = {
  name: 'list_accounts',
  description:
    'List the configured messaging accounts across all stations (PUBLIC identity only: ' +
    'addresses, bot ids/usernames). No args. Never returns tokens, private keys, or the ' +
    'mnemonic. Also returns `capabilities`: the ' +
    'message verbs (send/reply/react/unreact/edit/delete/read) each station honors, so a ' +
    'verb need not be discovered by trial and error.',
  inputSchema: { type: 'object', properties: {} },
};

export const MCP_INSTRUCTIONS =
  'Messages from Metro chat arrive as <channel source="metro" line="..." from="..." ' +
  'station="..." message_id="...">. To respond, use the messaging tools, always passing the ' +
  '`line` attribute verbatim (the station is derived from it): `send` (text and/or media via ' +
  '`attachments`, optional `reply_to`), `reply` (quote a `message_id` with `text`), `react`/' +
  '`unreact` (emoji on a `message_id`), `edit`/`delete` (a `message_id`), and `read` (recent ' +
  "history). Station support varies - the tool returns the daemon's reason if a verb is " +
  'unsupported on that line. An inbound attachment is surfaced as a note carrying the ' +
  "sender's own text alongside a `Public URL` - fetch that url to read the file; the note's " +
  '`local_path` resolves on the DAEMON host, not on yours, so the Read tool works on it only ' +
  'for an agent running there. To send a file OUT, call `create_upload`, ' +
  'run the one curl line it hands back (that step needs a shell; the bytes go from your disk ' +
  'straight to metro and never through this conversation), then `send` with ' +
  'attachments:[{upload:"<upload_id>"}]. Inline `data` is for tiny files only, `url` only for ' +
  'an already-public file, and `path` is read on the DAEMON host, not yours. Tool-approval ' +
  'prompts are relayed to the same chat - answer "yes <id>"/"no <id>".';
