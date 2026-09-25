export type Line = string & { readonly __line: unique symbol };
export const asLine = (s: string): Line => s as Line;

const PREFIX = 'metro://';
const build = (station: string, ...seg: (string | number)[]): Line =>
  asLine(`${PREFIX}${station}/${seg.map(String).join('/')}`);

function parseAccountScoped(
  line: Line | string,
  station: string,
  validate?: (resource: string) => boolean,
): { accountId: string; resource: string } | null {
  const p = Line.parse(line);
  if (p?.station !== station || p.path.length !== 2) return null;
  const [accountId, resource] = p.path;
  if (accountId === undefined || resource === undefined) return null;
  if (validate && !validate(resource)) return null;
  return { accountId, resource };
}

const isSnowflake = (s: string): boolean => /^\d+$/.test(s);
const isThreemaResource = (s: string): boolean =>
  /^(?:[A-Z0-9]{8}|\*[A-Z0-9]{7})(?:-[0-9a-f]{16})?$/i.test(s);
const isOutlookResource = (s: string): boolean => /^[A-Za-z0-9=_%.@+-]+$/.test(s);
const isSignedInt = (s: string): boolean => /^-?\d+$/.test(s);

function parseTelegramLine(
  line: Line | string,
): { accountId: string; chatId: number; topicId?: number } | null {
  const p = Line.parse(line);
  if (p?.station !== 'telegram-bot') return null;
  const [accountId, ...rest] = p.path;
  const [chatId, topicId] = rest;
  if (accountId === undefined) return null;
  if (rest.length < 1 || rest.length > 2 || chatId === undefined || !isSignedInt(chatId))
    return null;
  if (topicId !== undefined && !isSnowflake(topicId)) return null;
  return {
    accountId,
    chatId: Number(chatId),
    ...(topicId !== undefined ? { topicId: Number(topicId) } : {}),
  };
}

export const Line = {
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
  isLocal: (line: Line | string): boolean => Line.station(line) === 'claude',

  parseXmtp: (line: Line | string) => parseAccountScoped(line, 'xmtp'),

  parseDiscord: (line: Line | string) =>
    parseAccountScoped(line, 'discord-bot', isSnowflake),

  parseTelegram: (line: Line | string) => parseTelegramLine(line),

  parseThreema: (line: Line | string) =>
    parseAccountScoped(line, 'threema', isThreemaResource),

  parseOutlook: (line: Line | string) =>
    parseAccountScoped(line, 'outlook', isOutlookResource),
};
