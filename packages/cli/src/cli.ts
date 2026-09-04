#!/usr/bin/env node
import { hostname } from 'node:os';
import {
  claimCode,
  claimRuntime,
  mcpServers,
  NotSignedIn,
  whoisAuthorized,
} from './api.js';
import { askSecret } from './prompt.js';
import {
  clearToken,
  credentialsPath,
  metroWebUrl,
  writeToken,
} from './store.js';
import { detach, lockedBy, probe, runningPid, stopAll, tail } from './control.js';
import { tailEvents } from './tail.js';
import {
  assertAgentId,
  daemonPlan,
  localUrl,
  readRunToken,
  runDaemon,
  runtimeDir,
  runTokenState,
  writeRunToken,
} from './runtime.js';
import { launchClaude } from './claude.js';
import { bedrock } from './bedrock.js';
import { installPlugin, syncPluginServers } from './plugin.js';
import { update } from './update.js';
import { serve } from './serve.js';
import { currentVersion } from './version.js';

const USAGE = `metro — the command line for your MCP connectors

  metro start <agent-id> [--detach]
                  run that agent's stations on this machine
  metro serve [--port <n>] [--tunnel]
                  run a daemon of your own: its agents and stations live in ~/.metro/agents
                  here, and metro.box manages it through the link it prints; --tunnel adds
                  a public https address through a Cloudflare quick tunnel (needs
                  cloudflared, no account) so the link works from anywhere
  metro stop [agent-id]
                  stop every metro daemon on this machine, however it was started
  metro status <agent-id>
                  is it running, and is it healthy
  metro logs <agent-id> [-f]
                  show the detached daemon's log
  metro tail <agent-id>
                  follow this machine's inbound events, one JSON line each
  metro login [code]
                  authorize this machine for one agent with a code from its page
  metro logout    forget this machine's sign-in
  metro whoami [agent]
                  print the account and agent this machine may read
  metro mcp [agent]
                  print the mcpServers block of the agent's connectors; with a local daemon
                  running, its agent's connectors (name one if several)
  metro plugin    set up the Claude Code plugin (connector servers + /metro:login)
  metro claude [args...]
                  open Claude Code with the metro channel; every argument is passed through
  metro bedrock [args...]
                  the same, with inference on Amazon Bedrock through a local proxy so the
                  channel still works (needs AWS_BEARER_TOKEN_BEDROCK and AWS_REGION)
  metro update    update to the newest published version
  metro version   print this CLI's version

Start Claude Code with all of them, without writing them to disk:

  claude --mcp-config <(metro mcp)

  METRO_URL          the metro to talk to (default https://mcp.metro.box)
  METRO_UI_URL       where the web UI lives (default https://metro.box)
  METRO_TOKEN        use this agent sign-in instead of the stored one; with neither,
                     a machine running metro start uses its run token
  METRO_RUN_TOKEN    use this runtime authorization instead of the stored one
  METRO_BEDROCK_MODEL
                     send every request to this Bedrock model id (default: derive from the
                     model Claude Code asks for, e.g. eu.anthropic.claude-sonnet-4-6)
  METRO_RUNTIME_DIR  run the daemon from this directory instead of the bundled one
`;

function hostLabel(): string {
  const name = hostname().trim();
  return name === '' ? 'unnamed machine' : name;
}

async function authorizeRuntime(agentId: string): Promise<string> {
  process.stderr.write(
    `Authorize this machine with a pairing code for agent ${agentId} from ${metroWebUrl()}\n`,
  );
  const code = (await askSecret('Paste the code (input is hidden): ')).trim();
  if (code === '') throw new Error('no code given');
  const claimed = await claimRuntime(code, hostLabel());
  writeRunToken(claimed.agent, claimed.token);
  process.stderr.write(`Authorized as '${claimed.label}'.\n`);
  return claimed.token;
}

async function usableRunToken(agentId: string): Promise<string> {
  const stored = readRunToken(agentId);
  if (stored === null) return authorizeRuntime(agentId);
  const state = await runTokenState(stored);
  if (state !== 'stale') return stored;
  process.stderr.write(
    `metro no longer recognises this machine as the holder of ${agentId}: ` +
      'it was taken back, or another machine claimed it since. Authorize it again.\n',
  );
  return authorizeRuntime(agentId);
}

async function start(argv: string[]): Promise<number> {
  const agentId = assertAgentId(argv[0]);
  if (runningPid(agentId) !== null || lockedBy() !== null)
    throw new Error(
      'a metro daemon is already running on this machine. ' +
        'Stop it first: metro stop',
    );
  const dir = runtimeDir();
  const token = await usableRunToken(agentId);
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
  const agentId = argv[0] === undefined ? undefined : assertAgentId(argv[0]);
  const stopped = await stopAll(agentId);
  if (stopped.length === 0) {
    process.stderr.write('no metro daemon is running on this machine\n');
    return 1;
  }
  for (const d of stopped)
    process.stderr.write(`Stopped metro (pid ${String(d.pid)}, via ${d.via})\n`);
  return 0;
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

async function pastedCode(given: string | undefined): Promise<string> {
  if (given !== undefined && given.trim() !== '') return given.trim();
  process.stderr.write(
    `Get a pairing code for the agent from ${metroWebUrl()}\n`,
  );
  return askSecret('Paste the code here (input is hidden): ');
}

async function login(given: string | undefined): Promise<void> {
  const { token, subject, agent } = await claimCode(await pastedCode(given));
  writeToken(token);
  process.stderr.write(
    `Authorized '${agent}' for ${subject}. Stored in ${credentialsPath()}\n`,
  );
  if (syncPluginServers())
    process.stderr.write(
      'Claude Code plugin refreshed — new sessions have the connectors; ' +
        'run /reload-plugins in any session already open.\n',
    );
}

async function whoami(wanted: string | undefined): Promise<void> {
  const { subject, agent, where } = await whoisAuthorized(wanted);
  process.stdout.write(`${subject} · agent '${agent}' on ${where}\n`);
}

const HELP = new Set([undefined, 'help', '--help', '-h']);

const COMMANDS: Record<string, () => Promise<number>> = {
  login: async () => {
    await login(process.argv[3]);
    return 0;
  },
  logout: async () => {
    clearToken();
    process.stderr.write('Signed out.\n');
    return Promise.resolve(0);
  },
  whoami: async () => {
    await whoami(process.argv[3]);
    return 0;
  },
  start: () => start(process.argv.slice(3)),
  serve: () => serve(process.argv.slice(3)),
  stop: () => stopDaemon(process.argv.slice(3)),
  status: () => status(process.argv.slice(3)),
  logs: () => logs(process.argv.slice(3)),
  tail: () => tailEvents(process.argv.slice(3)),
  mcp: async () => {
    process.stdout.write(`${await mcpServers(process.argv[3])}\n`);
    return 0;
  },
  plugin: installPlugin,
  claude: () => launchClaude(process.argv.slice(3)),
  bedrock: () => bedrock(process.argv.slice(3)),
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
