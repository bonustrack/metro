import { type Connector } from './connectors';

export const MCP_CLIENTS = [
  'Claude Code',
  'Claude',
  'ChatGPT',
  'Codex',
  'Cursor',
] as const;

export type McpClient = (typeof MCP_CLIENTS)[number];

interface Credential {
  name: string;
  value: string;
  secret: string;
}

export type Install =
  | { kind: 'command'; value: string; secret: string | null; note: string }
  | { kind: 'deeplink'; label: string; href: string; note: string }
  | { kind: 'paste'; label: string; href: string; note: string };

const CLAUDE_CONNECTORS =
  'https://claude.ai/settings/connectors?modal=add-custom-connector';

const CHATGPT_CONNECTORS = 'https://chatgpt.com/#settings/Connectors';

const PASTE_NOTE =
  'This one cannot be filled in for you. Open the form and paste the values below.';

export function expiryNote(row: Connector, now = Date.now()): string {
  if (row.bearer === null) return '';
  if (row.expiresAt === null)
    return 'This carries the OAuth access token. Reconnect here if the client starts refusing it.';
  const minutes = Math.round((row.expiresAt - now) / 60_000);
  if (minutes <= 0)
    return 'That OAuth access token has already expired. Reconnect before you copy this.';
  return `This carries the OAuth access token, which expires in ${String(minutes)} min. After that the client reports a failed connection rather than signing in again — drop the header, or reconnect here and copy it afresh.`;
}

export function credential(row: Connector): Credential | null {
  if (row.header !== null && row.secret !== null)
    return { name: row.header, value: row.secret, secret: row.secret };
  if (row.bearer !== null && row.bearer !== '')
    return {
      name: 'Authorization',
      value: `Bearer ${row.bearer}`,
      secret: row.bearer,
    };
  return null;
}

function claudeCode(row: Connector): Install {
  const auth = credential(row);
  const base = `claude mcp add --transport http ${row.name} ${row.url}`;
  return {
    kind: 'command',
    value: auth === null ? base : `${base} --header "${auth.name}: ${auth.value}"`,
    secret: auth?.secret ?? null,
    note: 'Registers it for the directory you run it in, not globally.',
  };
}

function codexNote(row: Connector): string {
  if (credential(row) === null) return 'Codex picks the HTTP transport from the URL.';
  if (row.bearer !== null)
    return `Codex has no inline header flag. Sign in with “codex mcp login ${row.name}”, or export the token and add --bearer-token-env-var <VAR>.`;
  return 'Codex has no inline header flag: export the value and add --bearer-token-env-var <VAR>.';
}

function codex(row: Connector): Install {
  return {
    kind: 'command',
    value: `codex mcp add ${row.name} --url ${row.url}`,
    secret: null,
    note: codexNote(row),
  };
}

function cursorConfig(row: Connector): string {
  const auth = credential(row);
  const server: Record<string, unknown> = { type: 'http', url: row.url };
  if (auth !== null) server.headers = { [auth.name]: auth.value };
  return btoa(JSON.stringify(server));
}

export function cursorDeeplink(row: Connector): string {
  const name = encodeURIComponent(row.name);
  const config = encodeURIComponent(cursorConfig(row));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${name}&config=${config}`;
}

export function installFor(row: Connector, client: McpClient): Install {
  if (client === 'Claude Code') return claudeCode(row);
  if (client === 'Codex') return codex(row);
  if (client === 'Cursor')
    return {
      kind: 'deeplink',
      label: 'Add to Cursor',
      href: cursorDeeplink(row),
      note:
        credential(row) === null
          ? 'Opens Cursor and adds the server in one step.'
          : 'Opens Cursor and adds the server, credential included, in one step.',
    };
  if (client === 'Claude')
    return {
      kind: 'paste',
      label: 'Open Claude connectors',
      href: CLAUDE_CONNECTORS,
      note: PASTE_NOTE,
    };
  return {
    kind: 'paste',
    label: 'Open ChatGPT connectors',
    href: CHATGPT_CONNECTORS,
    note: PASTE_NOTE,
  };
}
