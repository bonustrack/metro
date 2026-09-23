const accountStrippedLine = (line: string): string => {
  const parts = line.split('/');
  if (parts.length < 5) return line;
  return [parts[0], parts[1], parts[2], ...parts.slice(4)].join('/');
};

export const dedupeKey = (
  station: string,
  line: string,
  kind: string,
  messageId: string,
): string => `${station} ${accountStrippedLine(line)} ${kind} ${messageId}`;
