# Metro

Monorepo for **Metro** — a live JSON stream of Telegram + Discord messages for your local Claude Code / Codex session.

## Layout

```
packages/
  metro/        # @stage-labs/metro — the CLI + daemon (see packages/metro/README.md)
apps/
  (Phase 2)     # Metro mobile app — coming soon under apps/app
```

## Packages

- [`@stage-labs/metro`](packages/metro/README.md) — install with `npm i -g @stage-labs/metro`. Run `metro` to get inbound Telegram + Discord messages on stdout and reply via CLI subcommands.

## Development

```sh
bun install
bun run build       # turbo run build
bun run test        # turbo run test
bun run typecheck   # turbo run typecheck
bun run lint        # turbo run lint
```

Tasks are orchestrated by [Turbo](https://turbo.build). See `turbo.json` for the pipeline.

## Roadmap

- **Phase 1** (this repo today): monorepo conversion, no behavior change to the published CLI.
- **Phase 2** ([#36](https://github.com/bonustrack/metro/issues/36)): `apps/app` Expo mobile app + new `/api/state` + `/api/tail` SSE endpoints on the daemon, plus `monitor.metro.box` hostname.

## License

[MIT](LICENSE)
