import { errMsg, log } from '@metro-labs/core/log';
import { ownerLine } from '../approvals/owner-line.js';
import { metroSend } from './permission-relay.js';

export function elsewhereText(id: string, asked: string | undefined, nameOf: (line: string) => string | undefined): string {
  if (asked === undefined) return `Approval ${id} is answered on metro.box, not in this chat.`;
  const name = nameOf(asked);
  const chat = asked === ownerLine()?.line ? 'your private chat with me' : 'the chat where I asked';
  return `Approval ${id} is answered in ${chat}${name === undefined ? '' : ` ("${name}")`} or on metro.box, not in this chat.`;
}

export async function pointToPrompt(id: string, asked: string | undefined, line: string, nameOf: (line: string) => string | undefined): Promise<void> {
  try {
    await metroSend(line, elsewhereText(id, asked, nameOf));
  } catch (err) {
    log.warn({ requestId: id, err: errMsg(err) }, 'approvals: an answer came in another chat, and that chat could not be told where to answer');
  }
}
