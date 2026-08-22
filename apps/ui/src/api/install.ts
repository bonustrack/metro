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

export type Needs = 'url' | 'credential';

export type Install =
  | { kind: 'command'; value: string; secret: string | null; note: string }
  | { kind: 'link'; label: string; href: string; note: string; needs: Needs[] };

const CLAUDE_INSTALL =
  'https://claude.ai/customize/connectors?modal=add-custom-connector';

const CHATGPT_CONNECTORS = 'https://chatgpt.com/#settings/Connectors';

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

function compactJson(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json) as unknown);
  } catch {
    return json;
  }
}

function singleQuoted(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
}

export function claudeSessionCommand(json: string): string {
  return `claude --mcp-config ${singleQuoted(compactJson(json))}`;
}

const BARE_ARG_RE = /^[A-Za-z0-9._:/-]+$/;

export function shellArg(value: string): string {
  if (BARE_ARG_RE.test(value)) return value;
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

function claudeCode(row: Connector): Install {
  const auth = credential(row);
  const base = `claude mcp add --transport http ${shellArg(row.exportName)} ${shellArg(row.url)}`;
  return {
    kind: 'command',
    value:
      auth === null
        ? base
        : `${base} --header ${shellArg(`${auth.name}: ${auth.value}`)}`,
    secret: auth?.secret ?? null,
    note: 'Registers it for the directory you run it in, not globally.',
  };
}

function codexNote(row: Connector): string {
  if (credential(row) === null) return 'Codex picks the HTTP transport from the URL.';
  if (row.bearer !== null)
    return `Codex has no inline header flag. Sign in with “codex mcp login ${row.exportName}”, or export the token and add --bearer-token-env-var <VAR>.`;
  return 'Codex has no inline header flag: export the value and add --bearer-token-env-var <VAR>.';
}

function codex(row: Connector): Install {
  return {
    kind: 'command',
    value: `codex mcp add ${shellArg(row.exportName)} --url ${shellArg(row.url)}`,
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
  const name = encodeURIComponent(row.exportName);
  const config = encodeURIComponent(cursorConfig(row));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${name}&config=${config}`;
}

export function claudeInstallUrl(row: Connector): string {
  const name = encodeURIComponent(row.exportName);
  const url = encodeURIComponent(row.url);
  return `${CLAUDE_INSTALL}&connectorName=${name}&connectorUrl=${url}`;
}

function cursor(row: Connector): Install {
  return {
    kind: 'link',
    label: 'Add to Cursor',
    href: cursorDeeplink(row),
    needs: [],
    note:
      credential(row) === null
        ? 'Opens Cursor and adds the server in one step.'
        : 'Opens Cursor and adds the server, credential included, in one step.',
  };
}

function claudeWeb(row: Connector): Install {
  const auth = credential(row);
  return {
    kind: 'link',
    label: 'Add to Claude',
    href: claudeInstallUrl(row),
    needs: auth === null ? [] : ['credential'],
    note:
      auth === null
        ? 'Opens Claude with the name and URL already filled in. You confirm before anything is added.'
        : 'Opens Claude with the name and URL already filled in. The link cannot carry a credential, so add the header below under Request headers before you confirm.',
  };
}

function chatgpt(row: Connector): Install {
  const auth = credential(row);
  return {
    kind: 'link',
    label: 'Open ChatGPT connectors',
    href: CHATGPT_CONNECTORS,
    needs: auth === null ? ['url'] : ['url', 'credential'],
    note: 'ChatGPT takes no install link. Open the form and paste the values below.',
  };
}

export function installFor(row: Connector, client: McpClient): Install {
  if (client === 'Claude Code') return claudeCode(row);
  if (client === 'Codex') return codex(row);
  if (client === 'Cursor') return cursor(row);
  if (client === 'Claude') return claudeWeb(row);
  return chatgpt(row);
}
