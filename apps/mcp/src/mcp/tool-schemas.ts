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
    'A file to attach. Provide `path` (preferred, absolute local path) or `url`.',
  properties: {
    path: {
      type: 'string',
      description: 'Absolute local path to the file (the daemon reads it).',
    },
    url: { type: 'string', description: 'http(s) URL (alternative to path).' },
    mime: {
      type: 'string',
      description: 'MIME type (guessed from extension if omitted).',
    },
    name: {
      type: 'string',
      description: 'Filename to present (defaults to basename).',
    },
  },
} as const;

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
      'attachments?. The station is derived from the line. Attachments are local paths ' +
      '(preferred) or urls the daemon reads. At least one of text/attachments is required.',
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
      'inboxId + address; discord: id + username/nick + roles + is_bot; telegram/telegram-user: ' +
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
      'Args: station (required, xmtp|telegram-user|discord|telegram), name (required), members? ' +
      '(string[]; xmtp: 0x address or inboxId, telegram-user: @username or user id, discord: ' +
      'user id), account? (which station account), parent? (discord only: the metro:// line of ' +
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
          description: 'The station to create the group on (xmtp|telegram-user|discord).',
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
      'line, station, supported, reason?, inviteLink?}. Only telegram-user supports this today; ' +
      'other stations return {supported:false, reason}. Never throws on "not supported".',
    inputSchema: {
      type: 'object',
      properties: { line: lineProp },
      required: ['line'],
    },
  },
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
  'unsupported on that line. Inbound attachments are surfaced as a note with an absolute ' +
  '`local_path` - Read that path to view the file. Tool-approval prompts are relayed to the ' +
  'same chat - answer "yes <id>"/"no <id>".';
