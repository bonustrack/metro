import { baseDomain } from './favicon.js';

interface BrandLogo {
  light: string;
  dark?: string;
}

const BY_HOST: Record<string, string> = {
  'gemini.google.com': 'gemini',
  'aws.amazon.com': 'aws',
  'mail.google.com': 'gmail',
  'gmailmcp.googleapis.com': 'gmail',
  'drive.google.com': 'googledrive',
};

const BY_DOMAIN: Record<string, string> = {
  'whatsapp.com': 'whatsapp',
  'whatsapp.net': 'whatsapp',
  'telegram.org': 'telegram',
  't.me': 'telegram',
  'discord.com': 'discord',
  'discord.gg': 'discord',
  'threema.ch': 'threema',
  'outlook.com': 'outlook',
  'office.com': 'outlook',
  'live.com': 'outlook',
  'microsoft.com': 'microsoft',
  'sharepoint.com': 'sharepoint',
  'linear.app': 'linear',
  'notion.so': 'notion',
  'notion.com': 'notion',
  'claude.ai': 'claude',
  'anthropic.com': 'claude',
  'slack.com': 'slack',
  'github.com': 'github',
  'openrouter.ai': 'openrouter',
  'openai.com': 'openai',
  'mistral.ai': 'mistral',
  'qwen.ai': 'qwen',
  'qwenlm.ai': 'qwen',
  'chatgpt.com': 'openai',
  'x.ai': 'grok',
  'grok.com': 'grok',
  'atlassian.com': 'atlassian',
  'atlassian.net': 'atlassian',
  'hubspot.com': 'hubspot',
  'stripe.com': 'stripe',
  'sentry.io': 'sentry',
  'asana.com': 'asana',
  'intercom.com': 'intercom',
  'intercom.io': 'intercom',
  'cloudflare.com': 'cloudflare',
  'figma.com': 'figma',
  'box.com': 'box',
  'zapier.com': 'zapier',
};

const WITH_DARK = new Set(['github', 'openrouter', 'aws', 'openai', 'grok']);

function logoOf(slug: string): BrandLogo {
  const light = `/brands/${slug}.svg`;
  return WITH_DARK.has(slug) ? { light, dark: `/brands/${slug}-dark.svg` } : { light };
}

export function brandLogo(url: string): BrandLogo | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const slug = BY_HOST[host] ?? BY_DOMAIN[baseDomain(host)];
  return slug === undefined ? null : logoOf(slug);
}

export function brandSrc(url: string, dark: boolean): string | null {
  const logo = brandLogo(url);
  if (logo === null) return null;
  return dark ? (logo.dark ?? logo.light) : logo.light;
}
