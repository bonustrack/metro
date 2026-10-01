import type { StationTool } from '@metro-labs/core/stations/types';
import {
  str,
  setChannelMetadata,
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
    name: 'ask',
    group: 'write',
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
    name: 'send_frame',
    group: 'write',
    description:
      'Post a frame in a Stage conversation: a small interactive view described in OpenAI ChatKit ' +
      'widget JSON (the same nodes and props as ChatKit: a Card, ListView or Basic root with Row, Col, ' +
      'Box, Text, Title, Caption, Markdown, Badge, Icon, Image, Button, Divider, Spacer, Form, Input, ' +
      'Textarea, Select, DatePicker, Checkbox, RadioGroup, Table...). Stage shows it in the chat as a card ' +
      '(title and description) that opens full screen. A tap on a Button onClickAction, a ListViewItem ' +
      'onClickAction, a Card confirm/cancel or a Form submit comes back to you as a reply to the frame: ' +
      '"Frame action: <type> <payload JSON>", with the values of the form fields added to the payload by ' +
      'name. Images must be https. Args: line (required), widget (required, the ChatKit widget object, at ' +
      'most 64K characters of JSON), title? and description? (shown on the card; taken from the first ' +
      'Title and text in the widget when missing). xmtp-only. Returns the frame messageId.',
    inputSchema: {
      type: 'object',
      properties: {
        line: lineProp,
        widget: {
          type: 'object',
          description:
            'ChatKit widget JSON, e.g. {"type":"Card","children":[{"type":"Title","value":"Deploy?"},' +
            '{"type":"Button","label":"Ship it","onClickAction":{"type":"deploy","payload":{"env":"prod"}}}]}.',
          additionalProperties: true,
        },
        title: { type: 'string', description: 'Card title in the chat (200 characters at most).' },
        description: { type: 'string', description: 'Card description in the chat (1000 characters at most).' },
      },
      required: ['line', 'widget'],
    },
    async handle(a, ctx) {
      const line = str(a.line);
      if (!line) return ctx.err('send_frame requires `line`');
      if (a.widget === undefined) return ctx.err('send_frame requires `widget`');
      const args: Record<string, unknown> = { line, widget: a.widget };
      if (a.title !== undefined) args.title = a.title;
      if (a.description !== undefined) args.description = a.description;
      return ctx.okJson(await ctx.call('sendFrame', args));
    },
  },
  {
    name: 'dm',
    group: 'write',
    description:
      'Open (or reuse) a 1:1 XMTP DM with an Ethereum address. Args: address (required, 0x...), ' +
      'account? (defaults to your only XMTP account). Returns the new metro:// line and ' +
      'convId. xmtp-only ' +
      '(daemon `newDm`). For a group, use create_group.',
    inputSchema: {
      type: 'object',
      properties: {
        address: {
          type: 'string',
          description: 'Recipient Ethereum 0x address.',
        },
        account: {
          type: 'string',
          description: 'XMTP account to DM from. Omit when you have only one.',
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
    group: 'read',
    description:
      "Read an XMTP channel's current metadata + membership. Args: line (required). Returns " +
      '{line, id, account, version (dm|group), name, memberCount, labels, github, preview, ' +
      'assigned, appData (stored JSON object), rawAppData (stored JSON string), ' +
      'members:[{inboxId, address}]}. Syncs first and fails if metadata cannot be read. ' +
      'xmtp-only (daemon `groupInfo`). Use before ' +
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
    name: 'close_channel',
    group: 'write',
    destructive: true,
    description:
      'Remove members from an XMTP group, and optionally leave it. Args: line (required), ' +
      'removeInboxIds? (inbox ids to remove; your own is ignored here), removeSelf? (true to ' +
      'leave the group yourself). With neither, nothing changes. xmtp-only (daemon ' +
      '`closeGroup`). Returns {removed, leftSelf}.',
    inputSchema: {
      type: 'object',
      properties: {
        line: lineProp,
        removeInboxIds: {
          type: 'array',
          description: 'Inbox ids of the members to remove.',
          items: { type: 'string' },
        },
        removeSelf: {
          type: 'boolean',
          description: 'Leave the group after removing the others.',
        },
      },
      required: ['line'],
    },
    async handle(a, ctx) {
      const line = str(a.line);
      if (!line) return ctx.err('close_channel requires `line`');
      const args: Record<string, unknown> = { line };
      if (Array.isArray(a.removeInboxIds)) args.removeInboxIds = a.removeInboxIds.map(String);
      if (a.removeSelf === true) args.removeSelf = true;
      return ctx.okJson(await ctx.call('closeGroup', args));
    },
  },
  {
    name: 'set_channel_metadata',
    group: 'write',
    description:
      "Update an existing channel's metadata. Args: line (required, the metro:// line), and " +
      'any of metadata? (JSON object), github? (url), preview? (url), name? (string). ' +
      'metadata is a shallow appData patch: omitted keys are preserved, supplied nested ' +
      'values replace that key, and null deletes custom keys. v is reserved. Put labels ' +
      'and assigned inside metadata. assigned replaces the array with normalized lowercase ' +
      'Ethereum addresses of current members. Read group_info and union existing IDs to ' +
      'add assignees. labels remains a legacy top-level alias. Duplicate top-level/metadata ' +
      'label/link aliases are refused. All fields use one updateChannelMeta call. xmtp-only. ' +
      'Returns updated metadata. Reread group_info to verify persistence.',
    inputSchema: {
      type: 'object',
      properties: {
        line: lineProp,
        metadata: {
          type: 'object',
          description: 'Shallow JSON appData patch. Omitted keys stay unchanged. v is reserved.',
          properties: {
            labels: { type: 'array', items: { type: 'string' } },
            assigned: {
              type: 'array',
              description: 'Replacement assignee list. Current member Ethereum addresses only. [] clears.',
              items: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
            },
            github: { type: 'string' },
            preview: { type: 'string' },
          },
          additionalProperties: true,
        },
        labels: {
          type: 'array',
          description: 'Legacy alias. Prefer metadata.labels.',
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

