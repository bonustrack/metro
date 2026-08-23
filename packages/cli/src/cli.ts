#!/usr/bin/env node
import { hostname } from 'node:os';
import {
  claimCode,
  claimRuntime,
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
import { detach, probe, runningPid, stop, tail } from './control.js';
import {
  assertAgentId,
  daemonPlan,
  localUrl,
  readRunToken,
  runDaemon,
  runtimeDir,
  writeRunToken,
} from './runtime.js';
import { update } from './update.js';
import { currentVersion } from './version.js';

const USAGE = `metro — the command line for your MCP connectors

  metro start <agent-id> [--detach]
                  run that agent's stations on this machine
  metro stop <agent-id>
                  stop the daemon started with --detach
  metro status <agent-id>
                  is it running, and is it healthy
  metro logs <agent-id> [-f]
                  show the detached daemon's log
  metro login     authorize a connector collection with a code from the web UI
  metro logout    forget this machine's sign-in
  metro whoami    print the account and collection this machine may read
  metro mcp       print the mcpServers block for the authorized collection
  metro update    update to the newest published version
  metro version   print this CLI's version

Start Claude Code with all of them, without writing them to disk:

  claude --mcp-config <(metro mcp)

  METRO_URL          the metro to talk to (default https://mcp.metro.box)
  METRO_UI_URL       where the web UI lives (default https://metro.box)
  METRO_TOKEN        use this connector sign-in instead of the stored one
  METRO_RUN_TOKEN    use this runtime authorization instead of the stored one
  METRO_RUNTIME_DIR  run the daemon from this directory instead of the bundled one
`;

function hostLabel(): string {
  const name = hostname().trim();
  return name === '' ? 'unnamed machine' : name;
}

async function authorizeRuntime(agentId: string): Promise<string> {
  process.stderr.write(
    `Authorize this machine at ${metroWebUrl()}/#/authorize/${agentId}\n`,
  );
  const code = (await askLine('Paste the code: ')).trim();
  if (code === '') throw new Error('no code given');
  const claimed = await claimRuntime(code, hostLabel());
  writeRunToken(claimed.agent, claimed.token);
  process.stderr.write(`Authorized as '${claimed.label}'.\n`);
  return claimed.token;
}

async function start(argv: string[]): Promise<number> {
  const agentId = assertAgentId(argv[0]);
  if (runningPid(agentId) !== null)
    throw new Error(`metro is already running for ${agentId} — stop it first`);
  const dir = runtimeDir();
  const token = readRunToken(agentId) ?? (await authorizeRuntime(agentId));
  const detached = argv.includes('--detach');
  const plan = daemonPlan({ agentId, token, dir });
  if (!detached) return runDaemon(agentId, plan);
  const pid = detach({ agentId, ...plan });
  process.stderr.write(
    `metro is running for ${agentId} (pid ${String(pid)})\n` +
      `  logs:  metro logs ${agentId} -f\n` +
      `  stop:  metro stop ${agentId}\n`,
  );
  return 0;
}

async function stopDaemon(argv: string[]): Promise<number> {
  const agentId = assertAgentId(argv[0]);
  const stopped = await stop(agentId);
  process.stderr.write(
    stopped ? `Stopped metro for ${agentId}\n` : `metro is not running for ${agentId}\n`,
  );
  return stopped ? 0 : 1;
}

async function status(argv: string[]): Promise<number> {
  const agentId = assertAgentId(argv[0]);
  const pid = runningPid(agentId);
  if (pid === null) {
    process.stdout.write(`${agentId}: not running\n`);
    return 1;
  }
  const health = await probe(localUrl());
  process.stdout.write(
    `${agentId}: running (pid ${String(pid)}) · ` +
      (health === null
        ? `not answering on ${localUrl()}\n`
        : `healthy, up ${String(health.uptime)}s\n`),
  );
  return health === null ? 1 : 0;
}

function logs(argv: string[]): Promise<number> {
  const agentId = assertAgentId(argv[0]);
  return tail(agentId, argv.includes('-f') || argv.includes('--follow'));
}

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
  start: () => start(process.argv.slice(3)),
  stop: () => stopDaemon(process.argv.slice(3)),
  status: () => status(process.argv.slice(3)),
  logs: () => logs(process.argv.slice(3)),
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
