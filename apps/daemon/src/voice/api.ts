import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, sessionRoute } from '@metro-labs/http/api-http';
import { patchVoice, publicVoice, readVoice, writeVoice } from './store.js';

const PATH = '/api/voice';

async function answer(req: IncomingMessage): Promise<unknown> {
  if (req.method === 'PUT') writeVoice(patchVoice(readVoice(), await readJsonBody(req)));
  return publicVoice(readVoice());
}

export function handleVoiceRequest(req: IncomingMessage, res: ServerResponse): boolean {
  return sessionRoute(req, res, { methods: { [PATH]: ['GET', 'PUT'] }, admin: ['PUT'], label: 'voice-api' }, () => answer(req));
}
