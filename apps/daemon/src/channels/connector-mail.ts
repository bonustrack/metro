import { mintId, type MetroEvent } from '@metro-labs/core/events';
import { isRecord } from '@metro-labs/core/is-record';
import { asLine } from '@metro-labs/core/lines';
import type { MailFile } from '@metro-labs/http/mcp-events';
import type { McpMail } from '@metro-labs/http/mcp-server-protocol';
import { isConnectorLine, noteConnectorLine } from '../agents/scope.js';

const KB = 1024;

export const connectorMailLine = (mail: Pick<McpMail, 'key' | 'connector' | 'threadId'>): string => `metro://${mail.key}/${mail.connector}/${encodeURIComponent(mail.threadId)}`;

function sizeWords(bytes: number): string {
  if (bytes < KB) return `${String(bytes)} bytes`;
  if (bytes < KB * KB) return `${String(Math.round(bytes / KB))} KB`;
  return `${(bytes / (KB * KB)).toFixed(1)} MB`;
}

const fileLine = (file: MailFile): string => `- ${file.name} (${file.mime}, ${sizeWords(file.size)}): ${file.url ?? 'no link, the file is too large or was not kept'}`;

function textOf(mail: McpMail): string {
  const head = mail.subject === '' ? '' : `Subject: ${mail.subject}\n\n`;
  const files = mail.attachments.length === 0 ? '' : `\n\nAttachments:\n${mail.attachments.map(fileLine).join('\n')}`;
  return `${head}${mail.text}${files}`;
}

export function connectorMailEvent(mail: McpMail, agentId: string, agentName: string | undefined): MetroEvent {
  noteConnectorLine(mail.key, mail.connector, agentId);
  const line = connectorMailLine(mail);
  return {
    id: mintId(),
    ts: mail.receivedAt,
    station: mail.key,
    line: asLine(line),
    lineName: mail.subject === '' ? '(no subject)' : mail.subject,
    from: asLine(`metro://${mail.key}/${mail.connector}/user/${mail.from.address}`),
    fromName: mail.from.name ?? mail.from.address,
    ...(mail.from.name === undefined ? {} : { fromDisplayName: mail.from.name }),
    to: asLine(line),
    text: textOf(mail),
    messageId: mail.messageId,
    ...(mail.to.length === 1 && mail.cc.length === 0 ? { isPrivate: true } : {}),
    senderVerified: mail.senderVerified,
    payload: { connector: { id: mail.connector, key: mail.key, name: mail.name }, threadId: mail.threadId, subject: mail.subject, to: mail.to, cc: mail.cc, files: mail.attachments },
    event: { type: 'msg' },
    ...(agentName === undefined ? {} : { agent: agentName }),
  };
}

export const knownSource = (stations: Set<string>, station: string, line: string): boolean => stations.has(station) || isConnectorLine(line);

export function connectorMeta(line: string, payload: unknown): Record<string, string> {
  if (!isConnectorLine(line)) return {};
  const connector = isRecord(payload) && isRecord(payload.connector) ? payload.connector : {};
  if (typeof connector.key !== 'string' || typeof connector.id !== 'string') return {};
  const meta: Record<string, string> = { connector: connector.key, connector_id: connector.id, reply_tool: `${connector.key}.reply` };
  if (!isRecord(payload)) return meta;
  if (typeof payload.threadId === 'string') meta.thread_id = payload.threadId;
  if (typeof payload.subject === 'string' && payload.subject !== '') meta.subject = payload.subject;
  return meta;
}
