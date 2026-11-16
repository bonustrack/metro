import type { ToolDef } from './tool-def.js';

export const attachmentItem = {
  type: 'object',
  description:
    'A file to attach. Provide EXACTLY ONE source; naming two is an error and so is naming ' +
    'none. Which one to use: `path` for a file on this machine, such as one a worker saved ' +
    'under ~/work (Metro runs on the same machine and reads it with your own rights, so no ' +
    'shell and no upload are needed); `upload` for a file you can only push over HTTP (call ' +
    '`create_upload` first, push the bytes, then name the id here); `data` ONLY for a tiny ' +
    'file, a few KB at most, because the base64 has to be written out verbatim in this tool ' +
    'call and long base64 gets corrupted in the writing; `url` when the file is ALREADY ' +
    'published somewhere Metro can fetch it.',
  properties: {
    upload: {
      type: 'string',
      description:
        'The `upload_id` of a file already pushed to metro over HTTP (`create_upload` mints ' +
        'the slot and the one-line command; the bytes never pass through this conversation). ' +
        'It takes files up to 64 MiB and publishes nothing. For a file on this machine use ' +
        '`path` instead. The upload belongs to your agent, expires 30 minutes after it is ' +
        'created, and no other agent can name it.',
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
        'Absolute path of a file on this machine: Metro runs where you run and reads it with ' +
        'your own rights. The route for a file a worker made. A path inside a hidden folder ' +
        '(a segment starting with a dot) is refused, so keep files to send somewhere like ' +
        '~/work.',
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
    'Reserve a slot to push a file to metro over HTTP so you can attach it with `send`, for ' +
    'a file that is not on this machine. For a file on this machine, such as one a worker ' +
    'saved under ~/work, skip this and attach it with `path`. Args: name? (the filename to ' +
    'present), mime?. Returns `upload_id`, a single-use `upload_url` and a ready-to-run ' +
    '`curl` line. ONE STEP NEEDS A SHELL: run that command (or any HTTP client) to push the ' +
    'bytes. Then: send({line, attachments:[{upload:"<upload_id>"}]}). Up to 64 MiB, expires ' +
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
