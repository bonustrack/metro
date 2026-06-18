# Metro

The **Metro protocol** — an event-interception wire for live chat streams into AI
coding sessions, exposed as a cloud **MCP server**.

## Package

- **[`packages/metro`](packages/metro)** — [`@metro-labs/metro`](https://www.npmjs.com/package/@metro-labs/metro)
  The single Metro package. It contains:
  - the **daemon** (`metro-daemon`, `src/server.ts`): supervises train
    subprocesses in `~/.metro/trains/` (or `METRO_TRAINS_DIR`), multiplexes their
    JSON event stream, runs the durable outbox, and serves the webhook + monitor
    HTTP/SSE API (`/api/call`, `/api/tail`, `/api/accounts`, `/health`);
  - the **MCP server** (`metro-channel`, `src/mcp/index.ts`): bridges Metro chat
    into AI sessions over **stdio** (local) or **Streamable HTTP** (cloud).

  Deploy with the root [`Dockerfile`](Dockerfile) — see [`deploy/`](deploy).

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
