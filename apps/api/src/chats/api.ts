import type { IncomingMessage, ServerResponse } from 'node:http';
import { apiFailure, cors, readJsonBody, sendJson } from '@metro-labs/http/api-http';
import type { KeySource } from '@metro-labs/http/user-token';
import { callerOf } from '../server-route.js';
import { createChat, listChats, readChat, type Caller, type ChatsDeps } from './read.js';
import { changeChat, pinChat, postMessage, removeChat, retryTicket, watchTicket } from './write.js';

const BODY_MAX = 128 * 1024;
const ID = '([A-Za-z0-9_-]{11})';

export interface ChatsApiDeps extends ChatsDeps {
  keys: KeySource;
}

type Handler = (deps: ChatsApiDeps, caller: Caller, params: string[], req: IncomingMessage) => Promise<unknown>;

interface Route {
  path: RegExp;
  methods: Partial<Record<string, Handler>>;
}

const body = (req: IncomingMessage): Promise<unknown> => readJsonBody(req, BODY_MAX);

const ROUTES: Route[] = [
  {
    path: /^\/api\/chats\/?$/,
    methods: {
      GET: (deps, caller) => listChats(deps, caller),
      POST: async (deps, caller, _p, req) => createChat(deps, caller, await body(req)),
    },
  },
  {
    path: new RegExp(`^/api/chats/${ID}$`),
    methods: {
      GET: (deps, caller, [id = ''], req) => readChat(deps, caller, id, !/[?&]seen=0(?:&|$)/.test(req.url ?? '')),
      PATCH: async (deps, caller, [id = ''], req) => changeChat(deps, caller, id, await body(req)),
      DELETE: (deps, caller, [id = '']) => removeChat(deps, caller, id),
    },
  },
  {
    path: new RegExp(`^/api/chats/${ID}/pin$`),
    methods: {
      PUT: (deps, caller, [id = '']) => pinChat(deps, caller, id, true),
      DELETE: (deps, caller, [id = '']) => pinChat(deps, caller, id, false),
    },
  },
  {
    path: new RegExp(`^/api/chats/${ID}/messages$`),
    methods: { POST: async (deps, caller, [id = ''], req) => postMessage(deps, caller, id, await body(req)) },
  },
  {
    path: new RegExp(`^/api/chats/${ID}/messages/${ID}/ticket$`),
    methods: { POST: (deps, caller, [id = '', message = '']) => retryTicket(deps, caller, id, message) },
  },
  {
    path: new RegExp(`^/api/chats/${ID}/ticket$`),
    methods: { POST: (deps, caller, [id = '']) => watchTicket(deps, caller, id) },
  },
];

async function answer(req: IncomingMessage, deps: ChatsApiDeps, handler: Handler, params: string[]): Promise<unknown> {
  const caller = await callerOf(req, deps.keys);
  return handler(deps, caller, params, req);
}

export function handleChatsApiRequest(req: IncomingMessage, res: ServerResponse, deps: ChatsApiDeps): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  const route = ROUTES.find((r) => r.path.test(path));
  if (route === undefined) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  const handler = route.methods[req.method ?? ''];
  if (handler === undefined) {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  const params = route.path.exec(path)?.slice(1) ?? [];
  answer(req, deps, handler, params)
    .then((result) => {
      sendJson(req, res, 200, result);
    })
    .catch((err: unknown) => {
      apiFailure(req, res, err, 'chats');
    });
  return true;
}
