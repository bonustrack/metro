import type { StationTool } from '../types.js';
import {
  str,
  createChannel,
  setChannelMetadata,
  memberOp,
  xmtpSendAttachments,
} from './tools-handlers.js';

export { xmtpSendAttachments };

const lineProp = {
  type: 'string',
  description:
    'The metro:// line (from the inbound <channel> tag). The station is derived from it.',
} as const;

export const XMTP_TOOLS: StationTool[] = [
  {
    name: 'create_channel',
    description:
      'Create a new XMTP group conversation (channel). Args: addresses (required, array of ' +
      'Ethereum 0x addresses to add as members), name (required, the group name), labels? ' +
      '(optional string[] status labels applied after creation), account? ' +
      '(default "tony"). Calls the daemon xmtp `newGroup`, then `updateChannelMeta` if labels ' +
      'are given. Returns the new metro:// line and convId. This is an xmtp-only operation. ' +
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
        labels: {
          type: 'array',
          description: 'Optional status labels to apply after creation.',
          items: { type: 'string' },
        },
        account: {
          type: 'string',
          description: 'XMTP account to create under (default "tony").',
        },
      },
      required: ['addresses', 'name'],
    },
    handle: (a, ctx) => createChannel(a, ctx),
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
        question: {
          type: 'string',
          description: 'The question text (single-question form).',
        },
        options: {
          type: 'array',
          description: 'Answer options for a single question.',
          items: { type: 'string' },
        },
        header: {
          type: 'string',
          description: 'Optional header/title for the poll.',
        },
        multiSelect: {
          type: 'boolean',
          description: 'Allow selecting multiple options.',
        },
        open: {
          type: 'boolean',
          description: 'Free-text answer (options optional).',
        },
        questions: {
          type: 'array',
          description:
            'Multiple questions (multi-question form). Each is {question, options?, header?, multiSelect?, open?}.',
          items: { type: 'object' },
        },
      },
      required: ['line'],
    },
    async handle(a, ctx) {
      const line = str(a.line);
      if (!line) return ctx.err('ask requires `line`');
      const args: Record<string, unknown> = { line };
      for (const k of [
        'question',
        'options',
        'header',
        'multiSelect',
        'open',
        'questions',
      ] as const) {
        if (a[k] !== undefined) args[k] = a[k];
      }
      if (a.question === undefined && a.questions === undefined) {
        return ctx.err(
          'ask requires `question` (single) or `questions` (multi)',
        );
      }
      return ctx.okJson(await ctx.call('ask', args));
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
        address: {
          type: 'string',
          description: 'Recipient Ethereum 0x address.',
        },
        account: {
          type: 'string',
          description: 'XMTP account to DM from (default "tony").',
        },
      },
      required: ['address'],
    },
    async handle(a, ctx) {
      const address = str(a.address);
      if (!address) return ctx.err('dm requires `address`');
      const dmArgs: Record<string, unknown> = { address };
      if (a.account) dmArgs.account = str(a.account);
      return ctx.okJson(await ctx.call('newDm', dmArgs));
    },
  },
  {
    name: 'group_info',
    description:
      "Read an XMTP channel's current metadata + membership. Args: line (required). Returns " +
      '{line, id, account, version (dm|group), name, memberCount, labels, github, preview, ' +
      'members:[{inboxId, address}]}. xmtp-only (daemon `groupInfo`). Use before ' +
      'set_channel_metadata/add_members to see current state.',
    inputSchema: {
      type: 'object',
      properties: { line: lineProp },
      required: ['line'],
    },
    async handle(a, ctx) {
      const line = str(a.line);
      if (!line) return ctx.err('group_info requires `line`');
      return ctx.okJson(await ctx.call('groupInfo', { line }));
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
        addresses: {
          type: 'array',
          description: 'Ethereum 0x addresses to add.',
          items: { type: 'string' },
        },
        inboxIds: {
          type: 'array',
          description: 'XMTP inboxIds to add.',
          items: { type: 'string' },
        },
      },
      required: ['line'],
    },
    handle: (a, ctx) => memberOp('add_members', 'addMembers', a, ctx),
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
        addresses: {
          type: 'array',
          description: 'Ethereum 0x addresses to remove.',
          items: { type: 'string' },
        },
        inboxIds: {
          type: 'array',
          description: 'XMTP inboxIds to remove.',
          items: { type: 'string' },
        },
      },
      required: ['line'],
    },
    handle: (a, ctx) => memberOp('remove_members', 'removeMembers', a, ctx),
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
    async handle(a, ctx) {
      const line = str(a.line);
      if (!line) return ctx.err('close_channel requires `line`');
      return ctx.okJson(await ctx.call('closeGroup', { line }));
    },
  },
  {
    name: 'set_channel_metadata',
    description:
      "Update an existing channel's metadata. Args: line (required, the metro:// line), and " +
      'any of labels? (string[]), github? (url), preview? (url), name? (string). All provided ' +
      'fields are applied together in one atomic updateChannelMeta daemon call (a single ' +
      'appData merge plus name update). xmtp-only ' +
      '(channel metadata lives on xmtp groups). Returns the updated channel info.',
    inputSchema: {
      type: 'object',
      properties: {
        line: lineProp,
        labels: {
          type: 'array',
          description: 'Status labels to set.',
          items: { type: 'string' },
        },
        github: {
          type: 'string',
          description: 'Linked GitHub URL ("" to clear).',
        },
        preview: {
          type: 'string',
          description: 'Linked preview URL ("" to clear).',
        },
        name: { type: 'string', description: 'New channel name.' },
      },
      required: ['line'],
    },
    handle: (a, ctx) => setChannelMetadata(a, ctx),
  },
];

