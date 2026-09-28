# Gmail channel

Metro's Gmail channel connects a Gmail or Google Workspace mailbox to an agent. New mail in the
Inbox reaches the agent as messages. Each email thread is one line. The agent answers in the
thread, starts new emails and searches the mailbox with Gmail's own search syntax.

Google has no app that Metro could share between customers for this. So each Google Workspace
brings its own OAuth client: an Internal app in a Google Cloud project of that Workspace. The
sign-in happens in the browser, and the tokens stay on the box.

## What the channel does

- It checks the Inbox every 30 seconds with the Gmail history API. The first check only notes
  where the mailbox is, so older mail is never replayed.
- It skips automated mail: no-reply senders, mailing lists and bulk mail.
- It marks an email as verified only when Google's own check passed for the sender's domain:
  DMARC, or a DKIM signature from that same domain. When the channel has a list of people, an
  email that is not verified is dropped.
- `send` on a thread answers everyone on its latest email. `reply` answers only the sender of one
  email. `send` to `metro://gmail/<account>/<email address>` starts a new email, with an optional
  `subject`.
- `read` with a `query` uses Gmail search syntax, for example
  `from:bea@example.com has:attachment newer_than:7d`.
- Files go up to 25 MB per email.
- It never changes the mailbox. Reading an email does not mark it as read, and nothing is
  labelled, archived or deleted.

### Scopes

The client asks for two scopes and nothing else:

- `https://www.googleapis.com/auth/gmail.readonly` to read mail and follow new mail.
- `https://www.googleapis.com/auth/gmail.send` to send mail.

`gmail.modify` would also let Metro change labels, mark mail as read and move mail to the trash.
The channel does not need that, so it does not ask for it. The one cost: an email the agent reads
stays unread in Gmail.

To keep one mailbox read-only, for example `admin@`, open that channel on metro.box and set
**Write** to **Block** under **What <agent> may do here**. Metro then refuses `send` and `reply`
on that mailbox, whatever the agent tries.

## Step 1: the Google Cloud project (a Workspace admin, once)

Do this signed in to the Google Cloud console with an account of the Workspace, for example
`admin@snapshot.org`. One project and one client serve every mailbox of the Workspace.

1. Create a project in the Workspace's organization, for example `Metro`, at
   https://console.cloud.google.com/projectcreate
2. Enable the Gmail API for that project at
   https://console.cloud.google.com/apis/library/gmail.googleapis.com
3. Open the Google Auth Platform at https://console.cloud.google.com/auth/overview and choose
   **Get started**. Name the app `Metro`, pick your address as the support email, choose
   **Internal** as the audience, add a contact address, and create it. Internal means only
   accounts of this Workspace can sign in, and Google does not review the app.
4. Under **Branding**, add `metro.box` to **Authorized domains**. Google asks for this before it
   accepts the redirect URI below.
5. Under **Data Access**, you may add the two scopes above. An Internal app works without this
   step, but listing them documents what the app does.
6. Under **Clients**, choose **Create client**, pick **Web application** and name it `Metro`.
   Under **Authorized redirect URIs**, add exactly `https://metro.box/` (with the final slash).
   Leave **Authorized JavaScript origins** empty. Choose **Create**.
7. Copy the **Client ID** and the **Client secret** right away. Google shows the secret only
   once. If it is lost, add a new secret on the client's page.

If the Workspace restricts third-party access to Gmail, the Google Admin console may block the
app. In that case open https://admin.google.com/ac/owl and trust the app: either the setting
**Trust internal, domain-owned apps** under **Settings**, or this client ID as a trusted app.

## Step 2: add each mailbox on metro.box (the box owner)

Repeat these steps once per mailbox, for example `admin@snapshot.org`, then
`fabien@snapshot.org`. The same client ID and secret serve both.

1. Open the agent on https://metro.box, go to **Channels** and choose **Connect channel**.
2. Pick **Gmail**. Paste the **Client ID** and the **Client secret** from step 1. Type the
   mailbox in **Mailbox**, for example `admin@snapshot.org`, so that Metro refuses any other
   account. Choose **Start sign-in**.
3. Choose **Sign in with Google**. In the new tab, pick that mailbox and allow the access.
   Google sends the tab back to metro.box, which says Gmail is connected. Close it. The first
   tab shows the new channel on its own.
4. Open the new channel. Under **People**, list who may write to the agent, for example
   `@snapshot.org` for everyone at the company. Under **What <agent> may do here**, set what
   the agent may do on this mailbox.
5. New mail reaches the agent from now on. Older mail stays out, but the agent can read it
   with `read`.

Deleting the channel on metro.box removes the tokens Metro keeps for it. To remove the access
on Google's side too, open https://myaccount.google.com/permissions with that mailbox and
remove **Metro**.

## If something refuses

- **"Google does not accept this client ID and secret"**: the secret was mistyped, or it
  belongs to another client. Check both on the **Clients** page.
- **Error 400: redirect_uri_mismatch** on Google's page: the client does not list
  `https://metro.box/` exactly, with the final slash. A change to a client can take from a few
  minutes to a few hours to apply.
- **Error 403: org_internal** on Google's page: the account is not in the Workspace that owns the
  project. Sign in with an account of that Workspace.
- **"Check that the Gmail API is enabled"**: step 1.2 was skipped, or it was done in another
  project.
- **"Your Google Workspace administrator blocks this app"**: trust the app in the Admin console,
  as described at the end of step 1.
- **"You signed in as X, not Y"**: Google's page picked another account. Start again and pick
  the mailbox typed in the form.
- **"Google refused to renew this mailbox's sign-in, so connect Gmail again"**: someone removed
  the access, changed the password, or deleted the client or its secret. Delete the channel and
  connect it again.
