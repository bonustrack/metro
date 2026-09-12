# Outlook and SharePoint through Microsoft's own MCP servers

Microsoft hosts one MCP server per Microsoft 365 workload, and a metro agent can hold each
of them as a connector: the agent's Claude Code session then reads and sends mail, manages
the calendar, and works with SharePoint and OneDrive files and lists as one Microsoft 365
user. Nothing sits between the box and Microsoft; the sign-in is Microsoft Entra, the
credential lives on the box, and the tenant's admin can allow or block every server from the
Microsoft 365 admin center. Microsoft calls these the Work IQ MCP servers and lists them as a
preview.

| Server | URL (replace `<tenant id>`) |
| --- | --- |
| Mail | `https://agent365.svc.cloud.microsoft/agents/tenants/<tenant id>/servers/mcp_MailTools` |
| Calendar | `https://agent365.svc.cloud.microsoft/agents/tenants/<tenant id>/servers/mcp_CalendarTools` |
| OneDrive and SharePoint files | `https://agent365.svc.cloud.microsoft/agents/tenants/<tenant id>/servers/mcp_ODSPRemoteServer` |
| SharePoint lists | `https://agent365.svc.cloud.microsoft/agents/tenants/<tenant id>/servers/mcp_SharePointListsTools` |
| Teams | `https://agent365.svc.cloud.microsoft/agents/tenants/<tenant id>/servers/mcp_TeamsServer` |
| Word | `https://agent365.svc.cloud.microsoft/agents/tenants/<tenant id>/servers/mcp_WordServer` |

## What the tenant needs

- **A Microsoft 365 user for the agent.** Give the agent its own account, with its own mailbox
  and OneDrive, and make that user a member of exactly the SharePoint sites it should reach.
  Access is scoped by what that user can see, not by the connector.
- **A Microsoft 365 Copilot licence on that user.** Microsoft requires it for the Work IQ MCP
  servers.
- **Someone who can register an app in Entra** and grant admin consent. This is a one-time
  step per tenant, done in the Microsoft Entra admin center.

## Step 1: register the app (tenant admin)

1. In the Microsoft Entra admin center, open **App registrations** and choose **New
   registration**. Name it `Metro`, keep **Accounts in this organizational directory only**.
2. Under **Authentication**, add a platform of type **Mobile and desktop applications** and
   enter the box's callback address as a custom redirect URI:
   `https://<box address>/api/connectors/callback`. The exact address is shown in metro's
   **Add connector** form, next to the Client ID field, and on the Server page as the public
   address. A box with no public address uses `http://127.0.0.1:8420/api/connectors/callback`.
3. Under **API permissions**, choose **Add a permission**, then **APIs my organization
   uses**, search for `WorkIQ`, and add the delegated permission for each server the agent
   should have, starting with **WorkIQ-MailServer** for mail. The permissions for the other
   servers sit beside it. Then **Grant admin consent** for the tenant.
4. From the **Overview** page copy the **Application (client) ID** and the **Directory
   (tenant) ID**.

Registering the redirect URI as a mobile and desktop platform makes the app a public client,
which is what Microsoft's own Claude Code sample uses. If you register it as a **Web** platform
instead, Entra will demand a client secret: create one under **Certificates & secrets** and
paste it into metro's Client secret field along with the client ID.

## Step 2: add the connectors in metro (the box owner)

1. Open the box on metro.box, go to **Connectors**, and choose **Add connector**.
2. Name it (`Outlook`, say), paste the server URL from the table with the tenant ID filled
   in, leave the header fields empty, and paste the **Client ID** from step 1.
3. Choose **Add**. metro sends you to Microsoft's sign-in: sign in as the agent's Microsoft 365
   user and accept the consent prompt. Microsoft sends you back to metro with the connector
   connected.
4. Repeat for each server the agent should hold. The same client ID serves all of them.
5. In the agent's running Claude Code session run `/reload-plugins --force`, or wait for the
   next restart. Each connector appears as its own MCP server.

Signing a connector out keeps the client ID, so **Connect** signs in again without a new
registration. Tokens are refreshed by the daemon; a sign-in Microsoft has revoked shows as a
connector that needs signing in again.

## If something refuses

- **"registers no clients on its own"** when adding: the Client ID field was left empty.
- **AADSTS50011** on Microsoft's page: the redirect URI in the app does not match the box's
  callback address character for character.
- **AADSTS65001** or a consent error: admin consent for the WorkIQ permissions was not
  granted, or the server is blocked in the Microsoft 365 admin center under Agents and Tools.
- **AADSTS7000218**: the app was registered as a Web platform and needs its client secret.
