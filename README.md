# Metro

Monorepo for the **Metro protocol** — an event-interception wire for live chat
streams into local AI coding sessions (Claude Code / Codex).

## Packages

- **[`packages/metro`](packages/metro)** — [`@metro-labs/metro`](https://www.npmjs.com/package/@metro-labs/metro)
  The core transport. Supervises train subprocesses in `~/.metro/trains/`,
  multiplexes their JSON event stream onto stdout, and routes outbound action
  calls back via stdin. Per-platform logic lives in train scripts; metro core is
  pure transport. Ships the `metro` CLI.

- **[`packages/mcp`](packages/mcp)** — `@metro-labs/metro-channel` (private)
  Claude Code Channel MCP server that bridges Metro inbound chat into a running
  CC session.

## Development

This is a [Bun](https://bun.sh) + [Turborepo](https://turbo.build) workspace.

```sh
bun install
bun run build      # build all packages
bun run typecheck  # type-check all packages
bun run test       # run tests
bun run lint       # lint
```

## License

MIT
