import type { ToolDef } from './tool-def.js';
import { attachmentItem, CREATE_UPLOAD_TOOL } from './attachment-schema.js';

const lineProp = {
  type: 'string',
  description:
    'The metro:// line (from the inbound <channel> tag). The station is derived from it.',
} as const;
const msgIdProp = {
  type: 'string',
  description: 'The target message_id.',
} as const;

export const COMMON_TOOLS: ToolDef[] = [
  {
    name: 'reply',
    group: 'write',
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
    group: 'write',
    description:
      'Send a message (and/or media) to a Metro conversation. Args: line, text?, reply_to?, ' +
      'subject?, attachments?. The station is derived from the line. Outlook: send to ' +
      'metro://outlook/<account>/<email address> to start a new email (subject defaults to the ' +
      'first line of text); the result names the new thread line. Each attachment names EXACTLY ONE ' +
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
        subject: {
          type: 'string',
          description: 'Outlook only: the subject of a new email.',
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
    group: 'write',
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
    group: 'write',
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
    group: 'write',
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
    group: 'write',
    destructive: true,
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
    group: 'read',
    description:
      'Read message history. Args: line?, account?, limit?, before?, since?, until?, query?, ' +
      'from?, unread_only?, message_id?. Give a line to read one conversation, or an account ' +
      '(from list_accounts) instead of a line to read across that whole account, where the ' +
      'station allows it. `message_id` returns that one message in full, with its files saved ' +
      'like inbound media (url and local_path). Each station applies the filters it supports; ' +
      'the answer lists any it did not apply in `ignored`, so check it. Returns the raw JSON ' +
      "(shapes differ per station), or the daemon's reason if the station does not support " +
      'reads. Outlook: `query` is a Microsoft search over all mail (with `from` folded into it; ' +
      'line, since, until and unread_only then narrow what the search found), and without ' +
      '`query` every filter is applied by Outlook itself, newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        line: lineProp,
        account: {
          type: 'string',
          description: 'An account id from list_accounts, to read the whole account when you give no line.',
        },
        limit: { type: 'number', description: 'Max messages to return.' },
        before: {
          type: 'string',
          description: 'Return messages before this message_id.',
        },
        since: {
          type: 'string',
          description: 'Return messages since this timestamp.',
        },
        until: {
          type: 'string',
          description: 'Return messages before this timestamp.',
        },
        query: { type: 'string', description: 'Free text to search for.' },
        from: { type: 'string', description: 'Only messages from this sender (an id or an address).' },
        unread_only: { type: 'boolean', description: 'Only messages not read yet.' },
        message_id: { type: 'string', description: 'Return this one message in full.' },
      },
    },
  },
  {
    name: 'list_members',
    group: 'read',
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
    group: 'write',
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
    group: 'write',
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
    group: 'write',
    destructive: true,
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
    group: 'write',
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

export const LIST_ACCOUNTS_TOOL: ToolDef = {
  name: 'list_accounts',
  group: 'read',
  description:
    'List the configured messaging accounts across all stations (PUBLIC identity only: ' +
    'addresses, bot ids/usernames). No args. Never returns tokens, private keys, or the ' +
    'mnemonic. Also returns `capabilities`: the ' +
    'message verbs (send/reply/react/unreact/edit/delete/read) each station honors, so a ' +
    'verb need not be discovered by trial and error.',
  inputSchema: { type: 'object', properties: {} },
};
