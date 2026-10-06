export const PRIVACY = `# Privacy policy

Updated 6 October 2026. Metro is operated by Stage Labs.

## What this policy covers

This policy describes the Metro website, account management services and software data flows. Metro connects an agent on a machine you manage to accounts and services you configure. Your organization controls that machine, its members and its integrations. Messaging networks, hosting services, identity services, connectors and AI providers have their own privacy practices.

## Website and account information

Metro uses WorkOS for sign-in and organization membership. Account management stores information such as your user identifier, email, profile name and avatar, account status, organization identifiers and slugs, and agent names, addresses and launch details. This information supports sign-in, access control, the agent list and server management.

The browser stores sign-in tokens, preferences, cached agent lists and pending Gmail or Outlook connection state in local storage. Pending connection state can remain there after the browser closes, until a later connection operation removes or replaces it. It uses session storage for sign-in redirects and invitation state. Metro's application does not use cookies for its own sign-in. Identity providers may use cookies on their own sites.

Hosting, identity and infrastructure services process information needed to serve the website, authenticate users and run machines. Operational logs and server metrics may include errors, service activity and resource usage. On the agent's machine, service logs can also contain message content and sender or recipient details.

## Connected accounts and permissions

You choose which messaging accounts and connectors to attach. Depending on the service, Metro processes account identifiers, authorization tokens, connection settings, sender details, message metadata, message text and attachments. Credentials for channels and connectors are kept by the Metro daemon on the agent's machine, not in the hosted account-management database.

New Gmail connections on supporting Metro versions request gmail.readonly. Sending requires a separate Google consent upgrade adding gmail.send, and Metro write permission. Older connections may already have both scopes. Gmail checks the connected mailbox, watches new Inbox messages and supports reading messages or threads. It does not request gmail.modify and does not mark messages as read. Read-only access still permits reading message contents and attachments throughout the mailbox. Review the provider's consent screen before connecting.

Managed Gmail sign-in uses Metro's Google application. The hosted API exchanges and refreshes Google tokens, sees them in process memory and returns them to the originating daemon over HTTPS. It does not store those tokens in the account-management database. The shared Google client secret stays at the hosted API; mailbox tokens and a signed refresh credential remain on the box. Pending authorization state includes the user, organization, server, requested mailbox and permissions, expires after ten minutes and is lost on API restart. Advanced bring-your-own-app connections instead keep their own Google client credentials on the box and contact Google directly. Managed Gmail credentials are excluded from Metro exports; reconnect them on the destination box.

## Message processing and storage

The Metro daemon receives messages from connected services on the agent's machine. It passes permitted events to the agent and can read account history through the connected service when a tool is used. Outgoing messages and actions are sent to the service you select. The hosted account-management API is not a relay or database for these messages.

This does not mean message content always stays on the machine. The agent may send content to its AI provider or to a connector when carrying out a task. Authorized organization members can also view agent sessions and files through the website, which connects to the machine.

The agent's harness can keep conversation transcripts, tool results, files and memory on the machine. Downloaded attachments and outbound uploads also use local caches. Attachment links grant access to the file to anyone holding the link, so do not share them beyond the intended recipients.

## AI services and connectors

Running an AI agent sends prompts and relevant context to the AI service used by its harness or the model connection you configure. That context can include messages, attachments, instructions, conversation history and tool results. A connector sends the tool request and related data to the connector service. Replies from these services return to the agent.

Review each service's privacy, retention and training terms before sending data. Choose services appropriate for the data you are authorized to process. Metro does not enforce every provider's retention or training settings. An optional provider setting is not a guarantee that all providers or all routes offer the same protections.

## Google API data and Limited Use

The Gmail integration uses Google account data to provide the mailbox and agent features you configure. Reading email into an agent's context may transfer that data to the AI service you use. Tools can also transfer data to recipients or connectors when instructed.

Google API use is subject to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy) and the [Google Workspace API User Data and Developer Policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy), including Limited Use requirements where applicable. Metro does not enforce a Google-data-specific check on every AI provider or connector you configure. This policy therefore does not claim that every configuration meets those requirements. Do not send Google account data to a service unless your configuration and use comply with Google's rules, including restrictions on advertising, sale of data, generalized AI model training and human access.

## Your controls and disconnection

You can choose the senders permitted to reach a channel, turn off incoming messages, turn off live delivery to the agent, and set supported channel and connector tools to Allow, Ask first or Block. Turning off incoming messages or live delivery does not disconnect the account or stop every tool from accessing it.

Remove a connected channel or connector to stop using it through Metro. Deleting managed Gmail first requests Google revocation; if that request fails, Metro keeps the channel for retry. Google revocation invalidates all permissions and tokens for that Google account across clients in the Google application project, so it can disconnect the same account on other Metro boxes too. After confirmed revocation, Metro deletes the local account configuration and attempts to remove its token and sync-state file. Local cleanup can fail if the machine encounters an error. Bring-your-own-app and older Gmail deletion remove local credentials without revoking Google authorization; revoke that access separately in Google Account settings. Cancelling an unfinished sign-in does not remove access already granted at Google. Disconnecting does not erase cached attachments, agent transcripts or memory, or messages already held by the messaging provider, recipients, AI services or other connectors.

You and your organization control the files, transcripts, memory, backups and running services on your machines. Review or remove stored data there when it is no longer needed. For organization-managed accounts and machines, work with your organization administrator.

## Access and security

Metro requires authenticated organization access to account management and the running daemon's administration APIs. The stopped-machine service can be started without that authentication. Metro applies configured tool policies to supported channel and connector calls. In the standard Linux installation, channel and connector credentials are stored under the daemon's system account, separate from the agent's account. Protect the machine itself, limit organization membership and keep the software updated. Protect exports and attachment links as sensitive data. These controls do not guarantee that every integration or action is safe.

## Retention and limits

Metro keeps account and organization records to support account management. Local credentials, connection state and agent files remain until removed or cleaned by the relevant software. Incoming attachment caches default to a seven-day age limit and a size cap. Outbound upload slots expire after 30 minutes. Cache cleanup runs periodically and settings may change these limits. These limits do not delete copies in agent transcripts, downloaded files, backups or third-party services. There is no universal automatic deletion period for local service logs, agent memory or arbitrary agent files.

Disconnecting an account is not a complete data-deletion request across all of these locations. Retention by your organization and external services depends on their own settings and practices. No system can guarantee that data is never lost, disclosed or misused. Keep access limited and do not connect data you cannot safely share with your chosen services.

## Changes

Changes to this policy will be published on this page with an updated date. Review it when changing your connections or the data you give your agent.
`;
