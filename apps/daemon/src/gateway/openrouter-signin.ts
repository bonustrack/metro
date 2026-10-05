import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, sessionRoute } from '@metro-labs/http/api-http';
import { log } from '@metro-labs/core/log';
import { publicBaseUrl } from '../files/attach-serve.js';
import { askedConnection, type ModelApiDeps, type Store } from './model-store.js';
import { OPENROUTER_CALLBACK, OpenRouterLogins } from './openrouter-login.js';

const LOGIN = '/api/model/openrouter/login';
const ID_RE = /^[A-Za-z0-9_-]{32}$/;
const logins = new WeakMap<ModelApiDeps, OpenRouterLogins>();
const CALLBACK_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
};

function loginFor(deps: ModelApiDeps, store: Store): OpenRouterLogins {
  let login = logins.get(deps);
  if (login === undefined) {
    login = new OpenRouterLogins({
      store,
      owner: () => deps.owner?.() ?? null,
      publicBase: deps.openrouterPublicBase ?? publicBaseUrl,
      fetchImpl: deps.fetchImpl,
      now: deps.openrouterNow,
    });
    logins.set(deps, login);
  }
  return login;
}

function callback(req: IncomingMessage, res: ServerResponse, login: OpenRouterLogins): void {
  if (req.method !== 'GET') {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return;
  }
  const url = new URL(req.url ?? '', 'https://metro');
  if (url.search === '') {
    res.writeHead(200, { ...CALLBACK_HEADERS, 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenRouter sign-in</title><h1>Return to Metro</h1><p>Check your connection in Metro. You can close this tab.</p><p>If you declined access, cancel the sign-in in Metro or use an API key.</p></html>');
    return;
  }
  const finish = (): void => { res.writeHead(303, { ...CALLBACK_HEADERS, location: OPENROUTER_CALLBACK }).end(); };
  login.complete(url.searchParams).then(finish, finish).catch(() => {
    log.warn('openrouter-signin: callback response closed');
    if (!res.writableEnded) res.end();
  });
}

export function handleOpenRouterSignIn(req: IncomingMessage, res: ServerResponse, deps: ModelApiDeps, store: Store): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (path === OPENROUTER_CALLBACK) {
    callback(req, res, loginFor(deps, store));
    return true;
  }
  const id = path.startsWith(`${LOGIN}/`) ? path.slice(LOGIN.length + 1) : '';
  if (path !== LOGIN && !ID_RE.test(id)) return false;
  return sessionRoute(req, res, { methods: { [path]: path === LOGIN ? ['POST'] : ['GET', 'DELETE'] }, admin: false, label: 'openrouter-signin' }, (session) => {
    const login = loginFor(deps, store);
    if (path === LOGIN) return Promise.resolve(login.begin(session.subject, askedConnection(req)));
    return Promise.resolve(req.method === 'DELETE' ? login.cancel(session.subject, id) : login.status(session.subject, id));
  });
}
