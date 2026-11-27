export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

export const RESERVED_SEGMENTS: ReadonlySet<string> = new Set(['docs', 'settings', 'connect', 'launch', 'activity', 'login', 'signup', 'waitlist', 'auth', 'members', 'organization', 'api', 'admin', 'metro', 'new', 'connector', 'connectors', 'chat', 'agents', 'terms-of-use', 'privacy-policy']);

export const AGENT_PAGES: ReadonlySet<string> = new Set(['approvals', 'run', 'server', 'settings', 'terminal', 'model', 'voice', 'harness', 'claude', 'skills', 'skill', 'scheduled', 'channels', 'channel', 'chats', 'tools', 'connectors', 'connector', 'sessions', 'memory', 'secrets', 'backup', 'profile', 'launch-log', 'keys']);

export const isSlugSegment = (segment: string): boolean => SLUG_RE.test(segment) && !RESERVED_SEGMENTS.has(segment);
