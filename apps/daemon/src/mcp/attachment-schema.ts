import type { ToolDef } from './tool-def.js';

export const attachmentItem = {
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

export const CREATE_UPLOAD_TOOL: ToolDef = {
  name: 'create_upload',
  group: 'write',
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
