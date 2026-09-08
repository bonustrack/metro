type Args = Record<string, unknown>;
export interface Normalized {
  action: string;
  args: Args;
}

interface Attachment {
  kind?: string;
  path?: string;
  url?: string;
  data?: string;
  mime?: string;
  name?: string;
}

interface DiscordFile {
  file: string;
  kind: string;
  name: string;
}

const discordFile = (a: Attachment): DiscordFile | null => {
  const file = a.path ?? a.url;
  if (typeof file !== 'string') return null;
  return { file, kind: a.kind ?? 'file', name: a.name ?? '' };
};

function discordAttachments(att: Attachment[]): Args {
  const usable = att
    .map(discordFile)
    .filter((f): f is DiscordFile => f !== null);
  if (!usable.length) return {};
  return {
    files: usable.map((f) => f.file),
    attachmentKinds: usable.map((f) => f.kind),
    attachmentNames: usable.map((f) => f.name),
  };
}

export function normalizeDiscord(action: string, env: Args): Normalized {
  const att = (env.attachments as Attachment[] | undefined) ?? [];
  if (action === 'send') {
    return { action: 'send', args: { ...env, ...discordAttachments(att) } };
  }
  if (action === 'reply') {
    const replyTo = env.replyTo ?? env.messageId;
    return {
      action: 'send',
      args: { ...env, replyTo, ...discordAttachments(att) },
    };
  }
  if (action === 'unreact')
    return { action: 'react', args: { ...env, emoji: '' } };
  if (action === 'read') {
    return {
      action: 'fetch',
      args: { line: env.line, limit: env.limit, before: env.before },
    };
  }
  return { action, args: env };
}

export function normalizeTelegram(action: string, env: Args): Normalized {
  if (action === 'reply') {
    return {
      action: 'send',
      args: {
        line: env.line,
        text: env.text,
        replyTo: env.replyTo,
        attachments: env.attachments,
      },
    };
  }
  if (action === 'unreact')
    return { action: 'react', args: { ...env, emoji: '' } };
  return { action, args: env };
}

export function normalizeXmtp(action: string, env: Args): Normalized {
  if (action === 'unreact') {
    return { action: 'react', args: { ...env, action: 'removed' } };
  }
  if (action === 'read') {
    return { action: 'query', args: { line: env.line, limit: env.limit } };
  }
  return { action, args: env };
}
