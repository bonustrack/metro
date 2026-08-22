#!/usr/bin/env node
import {
  claimCode,
  mcpServers,
  NotSignedIn,
  whoisAuthorized,
} from './api.js';
import { askLine } from './prompt.js';
import {
  clearToken,
  credentialsPath,
  metroUrl,
  metroWebUrl,
  writeToken,
} from './store.js';
import { update } from './update.js';
import { currentVersion } from './version.js';

const USAGE = `metro — the command line for your MCP connectors

  metro login     authorize a connector collection with a code from the web UI
  metro logout    forget this machine's sign-in
  metro whoami    print the account and collection this machine may read
  metro mcp       print the mcpServers block for the authorized collection
  metro update    update to the newest published version
  metro version   print this CLI's version

Start Claude Code with all of them, without writing them to disk:

  claude --mcp-config <(metro mcp)

  METRO_URL     the metro to talk to (default https://mcp.metro.box)
  METRO_TOKEN   use this session instead of the stored one
  METRO_UI_URL  where the web UI lives (default https://metro.box)
`;

async function login(): Promise<void> {
  process.stderr.write(
    `Choose a connector collection at ${metroWebUrl()}/#/authorize\n`,
  );
  const { token, email, collection } = await claimCode(
    await askLine('Paste the code here: '),
  );
  writeToken(token);
  process.stderr.write(
    `Authorized '${collection}' for ${email}. Stored in ${credentialsPath()}\n`,
  );
}

async function whoami(): Promise<void> {
  const { email, collection } = await whoisAuthorized();
  process.stdout.write(`${email} · collection '${collection}' on ${metroUrl()}\n`);
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
