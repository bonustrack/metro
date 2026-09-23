export const postInitialize = (url: string): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'probe', version: '0.0.0' },
      },
    }),
  });

export async function initSession(url: string): Promise<string> {
  const res = await postInitialize(url);
  const sessionId = res.headers.get('mcp-session-id');
  await res.body?.cancel();
  if (!sessionId) throw new Error('no session id from initialize');
  return sessionId;
}

export interface GetStream {
  raw: () => string;
  status: number;
  ended: () => boolean;
  stop: () => Promise<void>;
}

export async function openGet(url: string, sessionId: string, lastEventId?: string): Promise<GetStream> {
  const ac = new AbortController();
  const headers: Record<string, string> = {
    accept: 'text/event-stream',
    'mcp-session-id': sessionId,
    'mcp-protocol-version': '2025-06-18',
  };
  if (lastEventId !== undefined) headers['last-event-id'] = lastEventId;
  const res = await fetch(url, { method: 'GET', signal: ac.signal, headers });
  let raw = '';
  let ended = false;
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  const pump = (async () => {
    if (!reader) return;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          ended = true;
          break;
        }
        raw += decoder.decode(value, { stream: true });
      }
    } catch {
      return;
    }
  })();
  return {
    raw: () => raw,
    status: res.status,
    ended: () => ended,
    stop: async () => {
      ac.abort();
      await pump;
    },
  };
}
