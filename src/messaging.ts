export const STATIONS = ['xmtp', 'discord', 'telegram'] as const;
export type Station = (typeof STATIONS)[number];

export const unsupported = (verb: string, station: string): string =>
  `unsupported verb '${verb}' on ${station}`;
