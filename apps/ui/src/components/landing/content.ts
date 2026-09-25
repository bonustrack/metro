export interface Pillar {
  title: string;
  body: string;
}

export interface PartItem {
  name: string;
  url: string;
}

export interface Part {
  kind: string;
  title: string;
  body: string;
  items: PartItem[];
}

export interface Fact {
  value: string;
  label: string;
}

export const HERO = {
  title: ['Your AI agent.', 'Your server.', 'Your rules.'],
  body: 'Metro gives your team an AI agent that lives on your own server in Switzerland. Talk to it in WhatsApp, Outlook or Telegram. Nothing leaves without your rules.',
};

export const TRUST: PartItem[] = [
  { name: 'WhatsApp', url: 'https://whatsapp.com' },
  { name: 'Outlook', url: 'https://outlook.com' },
  { name: 'Telegram', url: 'https://telegram.org' },
  { name: 'Discord', url: 'https://discord.com' },
  { name: 'Threema', url: 'https://threema.ch' },
  { name: 'XMTP', url: 'https://xmtp.org' },
];

export const FACTS: Fact[] = [
  { value: '1 server', label: 'Per agent, in Zurich or Northern Virginia' },
  { value: 'E2E', label: 'WhatsApp messages are decrypted on your server only' },
  { value: '0 days', label: 'Of data retention at the model providers your agent uses' },
  { value: 'Sealed', label: 'Channel keys stay with Metro. Your agent cannot read them' },
];

export const PILLARS: Pillar[] = [
  {
    title: 'A server per agent',
    body: 'Every agent gets its own machine, in Zurich or Northern Virginia. Its memory and files live there, never on a shared platform.',
  },
  {
    title: 'End-to-end channels',
    body: 'WhatsApp messages are decrypted on your server, not by us. The same holds for other end-to-end apps like Threema.',
  },
  {
    title: 'Zero data retention',
    body: 'Route the model only to providers that keep nothing, or to AWS Bedrock. You choose the model for each server.',
  },
  {
    title: 'A vault for secrets',
    body: 'Turn it on and the agent only sees placeholders. The real key is added on the way out, only toward that key’s own website.',
  },
  {
    title: 'Separated by design',
    body: 'Claude Code runs as its own user. It cannot read the credentials of your channels or your tools.',
  },
  {
    title: 'Human in the loop',
    body: 'Set each tool to Allow, Ask or Block. Ask sends the approval to your chat, and only the people you name can say yes.',
  },
];

export const PARTS: Part[] = [
  {
    kind: 'Channels',
    title: 'Where your team talks to your agent',
    body: 'People write to it like to a colleague, in private or in a group. It only listens to the people you allow.',
    items: [
      { name: 'WhatsApp', url: 'https://whatsapp.com' },
      { name: 'Outlook', url: 'https://outlook.com' },
      { name: 'Telegram', url: 'https://telegram.org' },
      { name: 'Discord', url: 'https://discord.com' },
      { name: 'Threema', url: 'https://threema.ch' },
      { name: 'XMTP', url: 'https://xmtp.org' },
    ],
  },
  {
    kind: 'Connectors',
    title: 'The tools your agent may use',
    body: 'Any remote MCP server, your internal ones included. The key stays on your server and your agent never holds it.',
    items: [
      { name: 'Microsoft 365', url: 'https://microsoft.com' },
      { name: 'GitHub', url: 'https://github.com' },
      { name: 'Linear', url: 'https://linear.app' },
      { name: 'Notion', url: 'https://notion.so' },
      { name: 'Atlassian', url: 'https://atlassian.com' },
      { name: 'HubSpot', url: 'https://hubspot.com' },
      { name: 'Stripe', url: 'https://stripe.com' },
      { name: 'Sentry', url: 'https://sentry.io' },
    ],
  },
  {
    kind: 'Model',
    title: 'What your agent thinks with',
    body: 'Claude, OpenAI, Gemini, Grok, Mistral or Qwen, chosen per agent. Route only to providers that keep nothing, or through AWS Bedrock.',
    items: [
      { name: 'Claude', url: 'https://claude.ai' },
      { name: 'OpenAI', url: 'https://openai.com' },
      { name: 'Gemini', url: 'https://gemini.google.com' },
      { name: 'Grok', url: 'https://x.ai' },
      { name: 'Mistral', url: 'https://mistral.ai' },
      { name: 'Qwen', url: 'https://qwen.ai' },
      { name: 'OpenRouter', url: 'https://openrouter.ai' },
      { name: 'AWS Bedrock', url: 'https://aws.amazon.com' },
    ],
  },
];

export const NAV: { id: string; label: string }[] = [
  { id: 'parts', label: 'How it works' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'control', label: 'Control' },
];

export const WAITLIST_HASH = '#/waitlist';
export const LOGIN_HASH = '#/login';

export function scrollToSection(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
