#!/usr/bin/env node
import { mcpServers, NotSignedIn, sessionEmail } from './api.js';
import { signIn } from './login.js';
import { clearToken, credentialsPath, metroUrl, readEmail, writeToken } from './store.js';
import { update } from './update.js';
import { currentVersion } from './version.js';

const USAGE = `metro — the command line for your MCP connectors

  metro login     sign in to metro in your browser
  metro logout    forget this machine's sign-in
  metro whoami    print the account this machine is signed in as
  metro mcp       print an mcpServers block for every connector
  metro update    update to the newest published version
  metro version   print this CLI's version

Start Claude Code with all of them, without writing them to disk:

  claude --mcp-config <(metro mcp)

  METRO_URL     the metro to talk to (default https://mcp.metro.box)
  METRO_TOKEN   use this session instead of the stored one
`;

async function login(): Promise<void> {
  const token = await signIn();
  writeToken(token, '');
  const email = await sessionEmail().catch(() => '');
  if (email !== '') writeToken(token, email);
  process.stderr.write(
    `Signed in${email === '' ? '' : ` as ${email}`}. Stored in ${credentialsPath()}\n`,
  );
}

async function whoami(): Promise<void> {
  const email = await sessionEmail();
  const stored = readEmail();
  process.stdout.write(`${email === '' ? stored : email} on ${metroUrl()}\n`);
}

const HELP = new Set([undefined, 'help', '--help', '-h']);

const COMMANDS: Record<string, () => Promise<number>> = {
  login: async () => {
    await login();
    return 0;
  },
  logout: async () => {
    clearToken();
    process.stderr.write('Signed out.\n');
    return Promise.resolve(0);
  },
  whoami: async () => {
    await whoami();
    return 0;
  },
  mcp: async () => {
    process.stdout.write(`${await mcpServers()}\n`);
    return 0;
  },
  update,
  version: async () => {
    process.stdout.write(`${currentVersion()}\n`);
    return Promise.resolve(0);
  },
};

async function run(command: string | undefined): Promise<number> {
  const handler = command === undefined ? undefined : COMMANDS[command];
  if (handler !== undefined) return handler();
  process.stderr.write(USAGE);
  return Promise.resolve(HELP.has(command) ? 0 : 1);
}

const code = await run(process.argv[2]).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`metro: ${message}\n`);
  return err instanceof NotSignedIn ? 2 : 1;
});

process.exit(code);
