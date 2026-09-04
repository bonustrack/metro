#!/usr/bin/env node
import { mcpServers, whoisAuthorized } from './api.js';
import { stopAll } from './control.js';
import { tailEvents } from './tail.js';
import { launchClaude } from './claude.js';
import { bedrock } from './bedrock.js';
import { installPlugin } from './plugin.js';
import { update } from './update.js';
import { serve } from './serve.js';
import { currentVersion } from './version.js';

const USAGE = `metro — run your agent on this machine

  metro serve [--port <n>] [--tunnel] [--owner <address>]
                  run the daemon: the agent, its channels and its connectors live in
                  ~/.metro/agents here, and the page at metro.box manages it through the
                  link it prints; --owner names the one wallet that may sign in (remembered
                  after the first start); --tunnel adds a public https address through a
                  Cloudflare quick tunnel (needs cloudflared, no account) so the link works
                  from anywhere
  metro stop      stop the metro daemon on this machine
  metro tail <agent-id>
                  follow this machine's inbound events, one JSON line each
  metro whoami [agent]
                  print the agent this machine runs
  metro mcp [agent]
                  print the mcpServers block of the agent's connectors, served through the
                  daemon's own relay (name the agent if several live here)
  metro plugin    set up the Claude Code plugin (connector servers + /metro:refresh)
  metro claude [args...]
                  open Claude Code with the metro channel; every argument is passed through
  metro bedrock [args...]
                  the same, with inference on Amazon Bedrock through a local proxy so the
                  channel still works (needs AWS_BEARER_TOKEN_BEDROCK and AWS_REGION)
  metro update    update to the newest published version (--check only reports)
  metro version   print this CLI's version

Start Claude Code with every connector, writing nothing to disk:

  claude --mcp-config <(metro mcp)

  METRO_WEBHOOK_PORT the daemon's port (default 8420)
  METRO_AGENTS_DIR   where the agents live (default ~/.metro/agents)
  METRO_AGENT_KEY    the key metro tail presents, instead of the agent file's
  METRO_BEDROCK_MODEL
                     send every request to this Bedrock model id (default: derive from the
                     model Claude Code asks for, e.g. eu.anthropic.claude-sonnet-4-6)
  METRO_RUNTIME_DIR  run the daemon from this directory instead of the bundled one
`;

async function stopDaemon(): Promise<number> {
  const stopped = await stopAll();
  if (stopped.length === 0) {
    process.stderr.write('no metro daemon is running on this machine\n');
    return 1;
  }
  for (const d of stopped)
    process.stderr.write(`Stopped metro (pid ${String(d.pid)}, via ${d.via})\n`);
  return 0;
}

const HELP = new Set([undefined, 'help', '--help', '-h']);

const COMMANDS: Record<string, () => Promise<number>> = {
  whoami: async () => {
    const { agent, where } = await whoisAuthorized(process.argv[3]);
    process.stdout.write(`agent '${agent}' on ${where}\n`);
    return 0;
  },
  serve: () => serve(process.argv.slice(3)),
  stop: stopDaemon,
  tail: () => tailEvents(process.argv.slice(3)),
  mcp: async () => {
    process.stdout.write(`${await mcpServers(process.argv[3])}\n`);
    return 0;
  },
  plugin: installPlugin,
  claude: () => launchClaude(process.argv.slice(3)),
  bedrock: () => bedrock(process.argv.slice(3)),
  update: () => update(process.argv.slice(3)),
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
  return 1;
});

process.exit(code);
