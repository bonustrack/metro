import { branchFromPath, branchPath, channelKey } from './branchChannel.js';

const EAS_PROJECT_ID = '51aa82e1-6457-4e12-a9c2-30def4397e20';
const DEFAULT_PLATFORM = 'android';
const DEFAULT_BRANCH = 'main';
const LAUNCHER_PATH = '/preview-launcher.html';
const NOT_BRANCHES = new Set([LAUNCHER_PATH, '/index.html', '/favicon.svg', '/favicon.ico', '/robots.txt']);

const BUNDLER_HOST = 'bundler.metro.box';

const NO_BRANCH_MESSAGE = `No branch in this URL. Load https://${BUNDLER_HOST}/<branch>, for example https://${BUNDLER_HOST}/${DEFAULT_BRANCH}`;

function isExpoClient(request: Request): boolean {
  return request.headers.has('expo-platform');
}

export function isBrowserRequest(request: Request): boolean {
  if (isExpoClient(request)) return false;
  return (request.headers.get('accept') ?? '').includes('text/html');
}

export function manifestUrl(channel: string, request: Request): string {
  const target = new URL(`https://u.expo.dev/${EAS_PROJECT_ID}`);
  target.searchParams.set('channel-name', channel);
  const runtime = request.headers.get('expo-runtime-version');
  if (runtime) target.searchParams.set('runtime-version', runtime);
  target.searchParams.set('platform', request.headers.get('expo-platform') ?? DEFAULT_PLATFORM);
  return target.toString();
}

function branchFromRequest(pathname: string): string | null {
  if (pathname === '/') return DEFAULT_BRANCH;
  return NOT_BRANCHES.has(pathname) ? null : branchFromPath(pathname);
}

export function handleBundler(request: Request, launcher: string): Response | Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === LAUNCHER_PATH && !isExpoClient(request)) {
    return new Response(launcher, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } });
  }
  const branch = branchFromRequest(pathname);
  if (!branch) return new Response(NO_BRANCH_MESSAGE, { status: 404 });
  if (isBrowserRequest(request)) {
    const deepTarget = `https://${BUNDLER_HOST}${branchPath(branch)}`;
    return Response.redirect(`https://${BUNDLER_HOST}${LAUNCHER_PATH}?u=${encodeURIComponent(deepTarget)}`, 302);
  }
  const headers = new Headers(request.headers);
  headers.delete('host');
  return fetch(manifestUrl(channelKey(branch), request), { headers });
}
