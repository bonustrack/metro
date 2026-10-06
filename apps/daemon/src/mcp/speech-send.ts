import { speechTarget } from '@metro-labs/core/call';
import type { ToolResult } from '@metro-labs/core/stations/types';
import { sharedCalls } from '../voice/shared.js';
import { allowedAgents, currentIdentity } from './request-identity.js';
import { errResult, okJson } from './ctx.js';

export function sendSpeech(line: string, args: Record<string, unknown>): ToolResult {
  const target = speechTarget(args.speech);
  if (target === null) return errResult('Call speech needs callId, generation and sourceId from its authenticated source.');
  if (['reply_to', 'subject', 'attachments', 'frame', 'wallet', 'account'].some((key) => args[key] !== undefined))
    return errResult('Call speech cannot include chat content, media or an account override. Nothing was sent.');
  if (typeof args.text !== 'string') return errResult('Call speech needs text.');
  const receipt = sharedCalls.speak(line, target, args.text, allowedAgents(currentIdentity()));
  return okJson({ speech: receipt, delivery: 'Audio transport status only. No proof the caller heard it. No chat message was posted.' });
}
