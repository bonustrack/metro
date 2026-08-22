import { describe, expect, test } from 'bun:test';
import {
  claudeInstallUrl,
  claudeSessionCommand,
  cursorDeeplink,
  expiryNote,
  installFor,
  MCP_CLIENTS,
  shellArg,
  type McpClient,
} from '../src/api/install';
import { type Connector } from '../src/api/connectors';

const BASE: Connector = {
  id: 'id000000012',
  name: 'linear',
  exportName: 'metro.box linear',
  url: 'https://mcp.linear.app/mcp',
  transport: 'http',
  auth: 'none',
  header: null,
  secret: null,
  bearer: null,
  expiresAt: null,
  signIn: null,
  json: '{}',
  verified: null,
};

const KEYED: Connector = {
  ...BASE,
  auth: 'header',
  header: 'Authorization',
  secret: 'Bearer lin_oauth_7f',
};

const SIGNED_IN: Connector = {
  ...BASE,
  auth: 'oauth',
  signIn: 'connected',
  bearer: 'oat_live_9c31',
};

const commandFor = (row: Connector, client: McpClient): string => {
  const install = installFor(row, client);
  if (install.kind !== 'command') throw new Error(`${client} is not a command`);
  return install.value;
};

const cursorConfig = (row: Connector): unknown => {
  const config = new URL(cursorDeeplink(row)).searchParams.get('config') ?? '';
  return JSON.parse(atob(config));
};

describe('every client gets an install that fits how it actually adds a server', () => {
  test('each of the five resolves, and none falls through to another', () => {
    const kinds = MCP_CLIENTS.map((c) => [c, installFor(BASE, c).kind]);
    expect(kinds).toEqual([
      ['Claude Code', 'command'],
      ['Claude', 'link'],
      ['ChatGPT', 'link'],
      ['Codex', 'command'],
      ['Cursor', 'link'],
    ]);
  });

  test('only the client that cannot be pre-filled asks for the url', () => {
    const needs = MCP_CLIENTS.map((c) => {
      const install = installFor(BASE, c);
      return [c, install.kind === 'link' ? install.needs : []];
    });
    expect(needs).toEqual([
      ['Claude Code', []],
      ['Claude', []],
      ['ChatGPT', ['url']],
      ['Codex', []],
      ['Cursor', []],
    ]);
  });

  test('claude code names the transport and the url', () => {
    expect(commandFor(BASE, 'Claude Code')).toBe(
      'claude mcp add --transport http "metro.box linear" https://mcp.linear.app/mcp',
    );
  });

  test('codex takes the url and derives the transport from it', () => {
    expect(commandFor(BASE, 'Codex')).toBe(
      'codex mcp add "metro.box linear" --url https://mcp.linear.app/mcp',
    );
  });

  test('the web targets carry a real https destination, never a made-up scheme', () => {
    for (const client of ['Claude', 'ChatGPT'] as const) {
      const install = installFor(BASE, client);
      if (install.kind !== 'link') throw new Error('expected a link target');
      expect(new URL(install.href).protocol).toBe('https:');
    }
  });
});

describe('a name is a label now, so the commands have to quote it', () => {
  const SPACED: Connector = {
    ...BASE,
    name: 'My MySQL server',
    exportName: 'metro.box My MySQL server',
  };

  test('a plain name stays bare, so the common command reads cleanly', () => {
    expect(shellArg('linear')).toBe('linear');
    expect(shellArg('https://mcp.linear.app/mcp')).toBe(
      'https://mcp.linear.app/mcp',
    );
  });

  test('a name with spaces is quoted rather than split into two arguments', () => {
    expect(commandFor(SPACED, 'Claude Code')).toBe(
      'claude mcp add --transport http "metro.box My MySQL server" https://mcp.linear.app/mcp',
    );
    expect(commandFor(SPACED, 'Codex')).toBe(
      'codex mcp add "metro.box My MySQL server" --url https://mcp.linear.app/mcp',
    );
  });

  test('quotes and expansions in a name are escaped, not left to the shell', () => {
    expect(shellArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(shellArg('$(whoami)')).toBe('"\\$(whoami)"');
    expect(shellArg('back`tick`')).toBe('"back\\`tick\\`"');
  });

  test('the deeplink carries the prefixed name, decoded', () => {
    expect(new URL(cursorDeeplink(SPACED)).searchParams.get('name')).toBe(
      'metro.box My MySQL server',
    );
  });
});

describe('a stored credential rides only where the client can carry it', () => {
  test('claude code takes the header inline', () => {
    expect(commandFor(KEYED, 'Claude Code')).toBe(
      'claude mcp add --transport http "metro.box linear" https://mcp.linear.app/mcp' +
        ' --header "Authorization: Bearer lin_oauth_7f"',
    );
  });

  test('codex never inlines it — the flag it offers reads an env var', () => {
    const value = commandFor(KEYED, 'Codex');
    expect(value).not.toContain('lin_oauth_7f');
    expect(installFor(KEYED, 'Codex').note).toContain('--bearer-token-env-var');
  });

  test('cursor carries it inside the encoded config', () => {
    expect(cursorConfig(KEYED)).toEqual({
      type: 'http',
      url: 'https://mcp.linear.app/mcp',
      headers: { Authorization: 'Bearer lin_oauth_7f' },
    });
  });

  test('a signed-in connector exports its access token as a bearer header', () => {
    expect(commandFor(SIGNED_IN, 'Claude Code')).toBe(
      'claude mcp add --transport http "metro.box linear" https://mcp.linear.app/mcp' +
        ' --header "Authorization: Bearer oat_live_9c31"',
    );
    expect(cursorConfig(SIGNED_IN)).toEqual({
      type: 'http',
      url: 'https://mcp.linear.app/mcp',
      headers: { Authorization: 'Bearer oat_live_9c31' },
    });
  });

  test('a disconnected oauth connector has nothing to export', () => {
    const out: Connector = { ...SIGNED_IN, bearer: null, signIn: 'disconnected' };
    expect(commandFor(out, 'Claude Code')).not.toContain('--header');
    expect(cursorConfig(out)).toEqual({
      type: 'http',
      url: 'https://mcp.linear.app/mcp',
    });
  });

  test('a stored header wins over a bearer, so a row never exports two credentials', () => {
    const both: Connector = { ...KEYED, bearer: 'oat_live_9c31' };
    const value = commandFor(both, 'Claude Code');
    expect(value).toContain('Authorization: Bearer lin_oauth_7f');
    expect(value).not.toContain('oat_live_9c31');
  });

  test('the masked substring is the raw token, not the whole header value', () => {
    const install = installFor(SIGNED_IN, 'Claude Code');
    if (install.kind !== 'command') throw new Error('expected a command');
    expect(install.secret).toBe('oat_live_9c31');
  });

  test('a header with no value is not half-written into the command', () => {
    const half: Connector = { ...BASE, auth: 'header', header: 'X-Api-Key' };
    expect(commandFor(half, 'Claude Code')).not.toContain('--header');
    expect(cursorConfig(half)).toEqual({
      type: 'http',
      url: 'https://mcp.linear.app/mcp',
    });
  });
});

describe('a copied token says how long it is good for', () => {
  const AT = 1_800_000_000_000;

  test('a connector with no token says nothing', () => {
    expect(expiryNote(BASE)).toBe('');
    expect(expiryNote(KEYED)).toBe('');
  });

  test('a live token names the minutes it has left', () => {
    const row: Connector = { ...SIGNED_IN, expiresAt: AT + 43 * 60_000 };
    expect(expiryNote(row, AT)).toContain('expires in 43 min');
  });

  test('an expired token says so instead of counting down past zero', () => {
    const row: Connector = { ...SIGNED_IN, expiresAt: AT - 60_000 };
    expect(expiryNote(row, AT)).toContain('already expired');
  });

  test('a token with no stated expiry still warns rather than promising forever', () => {
    expect(expiryNote(SIGNED_IN, AT)).toContain('OAuth access token');
  });
});

describe('one paste starts a claude code session with every connector', () => {
  const PRETTY = JSON.stringify(
    { mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } } },
    null,
    2,
  );

  test('it is a claude --mcp-config command around single-quoted json', () => {
    expect(claudeSessionCommand(PRETTY)).toBe(
      "claude --mcp-config '" +
        '{"mcpServers":{"linear":{"type":"http","url":"https://mcp.linear.app/mcp"}}}' +
        "'",
    );
  });

  test('the json is compacted, so the command stays one line', () => {
    expect(claudeSessionCommand(PRETTY)).not.toContain('\n');
  });

  test('a quote inside a credential cannot end the shell string early', () => {
    const risky = JSON.stringify({
      mcpServers: { x: { headers: { Authorization: "it's" } } },
    });
    const command = claudeSessionCommand(risky);
    expect(command).toContain("'\\''");
    expect(command.startsWith("claude --mcp-config '")).toBe(true);
    expect(command.endsWith("'")).toBe(true);
  });

  test('json it cannot parse is passed through rather than dropped', () => {
    expect(claudeSessionCommand('not json')).toBe("claude --mcp-config 'not json'");
  });
});

describe('the claude install link pre-fills the dialog', () => {
  test('it names the modal and carries name and url as claude expects them', () => {
    const href = claudeInstallUrl(BASE);
    expect(href.startsWith('https://claude.ai/customize/connectors?')).toBe(true);
    const params = new URL(href).searchParams;
    expect(params.get('modal')).toBe('add-custom-connector');
    expect(params.get('connectorName')).toBe('metro.box linear');
    expect(params.get('connectorUrl')).toBe('https://mcp.linear.app/mcp');
  });

  test('the server url is percent-encoded, not left raw in the query', () => {
    expect(claudeInstallUrl(BASE)).toContain(
      'connectorUrl=https%3A%2F%2Fmcp.linear.app%2Fmcp',
    );
  });

  test('a credential cannot ride the link, so claude is told to paste it', () => {
    const install = installFor(KEYED, 'Claude');
    if (install.kind !== 'link') throw new Error('expected a link target');
    expect(install.needs).toEqual(['credential']);
    expect(install.href).not.toContain('lin_oauth_7f');
    expect(install.note).toContain('Request headers');
  });

  test('a connector with no credential asks for nothing extra', () => {
    const install = installFor(BASE, 'Claude');
    if (install.kind !== 'link') throw new Error('expected a link target');
    expect(install.needs).toEqual([]);
  });
});

describe('the cursor deeplink is shaped the way cursor reads it', () => {
  test('it names the scheme, the handler and both parameters', () => {
    const href = cursorDeeplink(BASE);
    expect(href.startsWith('cursor://anysphere.cursor-deeplink/mcp/install?')).toBe(
      true,
    );
    const params = new URL(href).searchParams;
    expect(params.get('name')).toBe('metro.box linear');
    expect(params.get('config')).not.toBe(null);
  });

  test('the config is base64 of the server block, not of the whole mcpServers map', () => {
    expect(cursorConfig(BASE)).toEqual({
      type: 'http',
      url: 'https://mcp.linear.app/mcp',
    });
  });
});
