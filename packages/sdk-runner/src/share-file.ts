import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { basename, extname, resolve, sep } from 'node:path';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { CHAT_FILE_MAX, fileNameOf } from '@metro-labs/core/chat';

export const CHAT_SERVER = 'chat';
export const SHARE_TOOL = `mcp__${CHAT_SERVER}__share_file`;

const DESCRIPTION =
  'Send a file or an image from this machine to the people in this metro.box chat. It shows in your reply, where they can open or download it. Give the path of a regular file you can read, 20 MB at most. Name it with name when the file name is not the one people should see.';

export interface SharedFile {
  path: string;
  name: string;
  type: string;
}

const TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  json: 'application/json',
  zip: 'application/zip',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export const typeOfName = (name: string): string => TYPES[extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream';

const UNREADABLE = 'You cannot read that file, so it cannot be shared.';

const within = (home: string, path: string): boolean => path === home || path.startsWith(`${home}${sep}`);

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

const MISSING = new Set(['ENOENT', 'ENOTDIR', 'ELOOP']);

function realOf(path: string): string | { refused: string } {
  try {
    return realpathSync(path);
  } catch (err) {
    const missing = MISSING.has(String((err as { code?: unknown }).code));
    return { refused: missing ? 'There is no file at that path.' : UNREADABLE };
  }
}

function readable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function checkShare(given: string, home: string, cwd: string): { path: string } | { refused: string } {
  const path = resolve(cwd, given);
  const real = realOf(path);
  if (typeof real !== 'string') return real;
  if (real !== path && !within(realOrSelf(home), real)) return { refused: 'That path is a link that leads out of your home folder, so it cannot be shared.' };
  const stat = statSync(real);
  if (stat.isDirectory()) return { refused: 'That is a folder. Share a file, or make a zip of the folder first.' };
  if (!stat.isFile()) return { refused: 'That is not a regular file, so it cannot be shared.' };
  if (stat.size > CHAT_FILE_MAX) return { refused: 'That file is over 20 MB, the most a chat file can be.' };
  return readable(real) ? { path } : { refused: UNREADABLE };
}

const said = (text: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text }], ...(isError ? { isError } : {}) });

export function shareAnswer(args: { path: string; name?: string }, share: (file: SharedFile) => boolean, home: string, cwd: string): CallToolResult {
  const checked = checkShare(args.path, home, cwd);
  if ('refused' in checked) return said(checked.refused, true);
  const name = fileNameOf(args.name) ?? fileNameOf(basename(checked.path)) ?? 'file';
  const type = typeOfName(extname(name) === '' ? checked.path : name);
  if (!share({ path: checked.path, name, type })) return said('This reply already holds as many parts as it can, so no more files can be added to it.', true);
  return said(`Shared ${name}.`);
}

export function chatServer(share: (file: SharedFile) => boolean, home: string, cwd: () => string = () => process.cwd()): McpSdkServerConfigWithInstance {
  const shareFile = tool(
    'share_file',
    DESCRIPTION,
    {
      path: z.string().describe('The path of the file on this machine, absolute or from your working folder.'),
      name: z.string().optional().describe('The file name people see, when it should differ from the file name on disk.'),
    },
    (args) =>
      Promise.resolve()
        .then(() => shareAnswer(args, share, home, cwd()))
        .catch(() => said('That file could not be shared.', true)),
    { annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  );
  return createSdkMcpServer({ name: CHAT_SERVER, version: '0.1.0', alwaysLoad: true, tools: [shareFile] });
}
