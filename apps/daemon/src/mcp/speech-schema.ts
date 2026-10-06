export const speechSchema = {
  type: 'object',
  description: 'Speak text only in the exact active Stage call, without posting it in chat. Copy callId, generation and sourceId from its authenticated call input or call_id, call_generation and call_source_id from the requesting channel message. Use only for a call reply or an explicit owner request to speak in that call. Normal chat and worker results stay silent. One action per source; retries do not repeat speech. Accepted or queued is not heard. Completed means audio transport drained, not proof the caller heard it.',
  properties: {
    callId: { type: 'string' },
    generation: { type: 'string' },
    sourceId: { type: 'string' },
  },
  required: ['callId', 'generation', 'sourceId'],
  additionalProperties: false,
} as const;
