# Phone notifications (Android)

When a connector call needs approval, every member of the agent's organization gets one
notification on their phone. A tap opens the approval page on metro.box
(`#/<org>/<agent>/approvals/<id>`). Rules: `docs/rules/APP.md` (the app),
`docs/rules/HTTP-API.md` (the routes and the sender), `docs/MCP-SERVER.md` (the Ask).

## How a notification reaches a phone

1. The app, signed in on Android, asks for permission once, gets an Expo push token and sends
   it to api.metro.box (`POST /api/push/devices`), which keeps it in `push_devices` with the
   user id.
2. An agent calls a connector tool whose rule is Ask. mcp.metro.box records the request in
   `mcp_approvals`, answers `needs_approval` at once and, only when the request is new, writes
   one row in `push_outbox` (Postgres, shared with api.metro.box). mcp.metro.box never reads
   the members and never calls Expo.
3. Within about 3 seconds, api.metro.box claims the row, reads the organization's members
   from Postgres, their tokens from `push_devices`, and posts the notification to Expo's push
   service (`https://exp.host/--/api/v2/push/send`). A failure is tried again a few times.
4. Expo hands it to Firebase Cloud Messaging (FCM), which delivers it to the phone.
5. A tap opens `https://metro.box/#/<org id>/<agent id>/approvals/<id>` in the app, where any
   member approves or denies.

Nothing works on a phone until steps 1 to 4 and 6 of the setup below are done: without
Firebase the app cannot get a token, and Expo cannot reach the phone without the FCM key.

## What the owner sets up, once

The app ids, from `apps/app/app.config.js`:

- `box.metro.dev`: the dev client (EAS profiles `development` and `preview`).
- `box.metro`: the store app (`production`, `APP_VARIANT=prod`).

1. **Create the Firebase project and its Android apps.** Open
   https://console.firebase.google.com/ and create a project (Google Analytics is not needed).
   In it, add an Android app with the package name `box.metro.dev`, then a second Android app
   with `box.metro`. Skip the SDK steps the console shows; Expo does them.
2. **Download `google-services.json`** from the project settings, after both apps exist, so
   the one file lists both: https://console.firebase.google.com/project/_/settings/general
   (pick the project, then "google-services.json" under either Android app). Do not commit it:
   `apps/app/.gitignore` ignores it.
3. **Give it to EAS as a file variable named `GOOGLE_SERVICES_JSON`**, in the three
   environments, on https://expo.dev/accounts/bonustrack/projects/metro-app/environment-variables
   (Add variable, type File, visibility Secret), or from `apps/app`:

   ```
   eas env:create --name GOOGLE_SERVICES_JSON --type file --value ./google-services.json --visibility secret --environment development --environment preview --environment production
   ```

   `app.config.js` points `android.googleServicesFile` at that file only when the variable is
   set; without it the app still builds and simply cannot receive notifications.
4. **Upload the FCM V1 service account key to EAS.** In Firebase, open Project settings,
   Service accounts, and click "Generate new private key":
   https://console.firebase.google.com/project/_/settings/serviceaccounts/adminsdk
   Then add that JSON key on Expo for both app ids, `box.metro.dev` and `box.metro`:
   https://expo.dev/accounts/bonustrack/projects/metro-app/credentials (Android, the app id,
   "FCM V1 service account key", Add). From the terminal, `eas credentials -p android` in
   `apps/app`, then Google Service Account, then "Manage your Google Service Account Key for
   Push Notifications (FCM V1)".
5. **Only if the Expo project has "Enhanced security for push notifications" on**
   (https://expo.dev/accounts/bonustrack/projects/metro-app/settings): create an access token
   at https://expo.dev/accounts/bonustrack/settings/access-tokens and give it to
   api.metro.box, which is the one that sends (https://fly.io/apps/metro/secrets):

   ```
   fly secrets set EXPO_ACCESS_TOKEN=<token> -a metro
   ```

   With that setting off, nothing is needed. Nothing is set on mcp.metro.box: it only writes
   the outbox, and api.metro.box reads the members from its own database.
6. **Rebuild the Android dev client.** The Firebase file is left out of the app's runtime
   fingerprint (so GitHub, which never has it, resolves the same runtime as EAS), so adding it
   does not start a build by itself. Run "App dev client APK" on `main` with **rebuild** (and
   **publish_rolling**) checked:
   https://github.com/bonustrack/metro/actions/workflows/app-dev-client.yml
   Install the new APK on the phone. A store build (`production`) picks the file up whenever
   it is built.

## Check it

1. On the phone, sign in. After a few seconds Android asks to allow notifications: allow.
   Settings (Organization tab, your account) shows "Notify me about approvals" on.
2. On metro.box, set a connector tool of an agent to Ask, and ask the agent to use it.
3. The phone shows "<agent> needs your approval", "<tool> on <connector>". Tap it: the app
   opens that approval's page.

If nothing arrives: api.metro.box's log (https://fly.io/apps/metro/monitoring) says
`push: notification sent` with `devices` and `sent` counts, or why not (`phone
notifications are off`, `Expo refused a batch` with the status, `notification given up`).
Expo's own view of a ticket: https://expo.dev/notifications

## Not done yet

- The box side: Claude Code permission prompts and the channel approvals a box asks itself
  never reach mcp.metro.box, so they do not notify. The box will queue them through a signed
  api.metro.box route into the same `push_outbox` (`queuePush`).
- iOS (APNs key, the iOS permission flow and switch).
- Push receipts: a token Expo only reports as gone in a later receipt stays until a ticket
  says `DeviceNotRegistered`.
