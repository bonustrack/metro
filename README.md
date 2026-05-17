# Metro

Monorepo for **Metro** — an event-interception wire that supervises train subprocesses in `~/.metro/trains/` and multiplexes their JSON event streams onto stdout. Per-platform code is written as train scripts outside this repo.

## Layout

```
packages/
  metro/        # @stage-labs/metro — the CLI + daemon (see packages/metro/README.md)
apps/
  app/          # Metro mobile app — read-only activity monitor (Expo + RN, see apps/app/README.md)
```

## Packages

- [`@stage-labs/metro`](packages/metro/README.md) — install with `npm i -g @stage-labs/metro`. Run `metro` to multiplex train events onto stdout and forward action calls via `metro call <train> <action> <args>`.
- [`@stage-labs/metro-app`](apps/app/README.md) — Expo / React Native mobile companion. View live activity + claimed lines from your phone via the daemon's bearer-token-gated monitor endpoints. Run with `bun --cwd apps/app start`.

The daemon's monitor endpoints (`/api/state`, `/api/tail`) are spec'd in
[`packages/metro/docs/monitor.md`](packages/metro/docs/monitor.md) — set
`METRO_MONITOR_TOKEN` in `~/.config/metro/.env` to enable them.

## Development

```sh
bun install
bun run build       # turbo run build
bun run test        # turbo run test
bun run typecheck   # turbo run typecheck
bun run lint        # turbo run lint
```

Tasks are orchestrated by [Turbo](https://turbo.build). See `turbo.json` for the pipeline.

## License

[MIT](LICENSE)
