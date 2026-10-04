# @metro-labs/app

Metro for the web (https://metro.box) and for Android and iOS, one Expo app with one
code, like Stage's `apps/stage`. It manages your Metro agents: each agent is a box
running `metro serve`, and the app talks to that box directly over its own address.

Built with Expo Router, React Native, react-native-web and `@stage-labs/kit`. The logic
without React (the API clients, sign-in, the route grammar, the `.metro` format) is in
`packages/client` (`@metro-labs/client`).

## Run locally

```sh
bun apps/daemon/src/server.ts     # a daemon on http://127.0.0.1:8420
cd apps/app && bun run web        # the web app on http://localhost:8081
cd apps/app && bun run start      # Metro bundler for the dev client on a phone
```

`EXPO_PUBLIC_METRO_API_URL` points the app at another api.metro.box (default
`https://api.metro.box`).

## Build and deploy

- `bun run build` writes the web export to `dist/`. Netlify builds it for metro.box and
  for every pull request (the root `netlify.toml`).
- The phone app is a dev client. `App dev client APK` (`.github/workflows/app-dev-client.yml`)
  builds an APK on EAS when the native fingerprint changes and puts it on the
  `app-dev-client` release. `App preview` publishes each push as an EAS Update on the
  branch's channel; open its `metro://expo-development-client/?url=...` link on the phone.
  Both need the `EXPO_TOKEN` secret and the EAS project id in `app.config.js`.
- App ids: `box.metro.dev` for the dev build, `box.metro` with `APP_VARIANT=prod`.
