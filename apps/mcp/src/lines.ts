export type Line = string & { readonly __line: unique symbol };
export const asLine = (s: string): Line => s as Line;

const PREFIX = 'metro://';
const build = (station: string, ...seg: (string | number)[]): Line =>
  asLine(`${PREFIX}${station}/${seg.map(String).join('/')}`);

function parseLocalSession(
  line: Line | string,
  station: 'claude',
): { userId: string; sessionId: string } | null {
  const p = Line.parse(line);
  if (p?.station !== station || p.path[0] === 'user' || p.path.length < 2)
    return null;
  return { userId: p.path[0], sessionId: p.path[1] };
}

export function parseAccountScoped(
  line: Line | string,
  station: string,
  validate?: (resource: string) => boolean,
): { accountId: string; resource: string } | null {
  const p = Line.parse(line);
  if (p?.station !== station) return null;
  let accountId: string, resource: string;
  if (p.path.length === 2) {
    accountId = p.path[0];
    resource = p.path[1];
  } else if (p.path.length === 1) {
    accountId = 'default';
    resource = p.path[0];
  } else return null;
  if (validate && !validate(resource)) return null;
  return { accountId, resource };
}

const isSnowflake = (s: string): boolean => /^\d+$/.test(s);

export const Line = {
  discord: (channelId: string): Line => build('discord', channelId),
  telegram: (chatId: number | string, topicId?: number): Line =>
    topicId !== undefined
      ? build('telegram', chatId, topicId)
      : build('telegram', chatId),
  claude: (orgId: string, sessionId: string): Line =>
    build('claude', orgId, sessionId),
  webhook: (endpointId: string): Line => build('webhook', endpointId),
  user: (station: string, id: string | number): Line =>
    build(station, 'user', id),

  parse(line: Line | string): { station: string; path: string[] } | null {
    if (!line.startsWith(PREFIX)) return null;
    const rest = line.slice(PREFIX.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) return null;
    const path = rest
      .slice(slash + 1)
      .split('/')
      .filter(Boolean);
    return path.length ? { station: rest.slice(0, slash), path } : null;
  },
  station: (line: Line | string): string | null =>
    Line.parse(line)?.station ?? null,
  parseClaude: (line: Line | string) => parseLocalSession(line, 'claude'),
  isLocal: (line: Line | string): boolean => Line.station(line) === 'claude',

  parseXmtp: (line: Line | string) => parseAccountScoped(line, 'xmtp'),

  parseDiscord: (line: Line | string) =>
    parseAccountScoped(line, 'discord', isSnowflake),
};
