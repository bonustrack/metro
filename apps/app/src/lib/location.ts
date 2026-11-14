import { readOrgConnectorReturn, type OrgConnectorReturn } from '@metro-labs/client/api/org-connectors';
import { readOpenRouterReturn, type OpenRouterReturn } from '@metro-labs/client/api/org-models';
import { Platform } from 'react-native';
import { router } from 'expo-router';
import { fetch as expoFetch } from 'expo/fetch';
import { configurePlatform, HOSTED_API } from '@metro-labs/client/platform';

const WEB = Platform.OS === 'web';
const WEB_HOME = 'https://metro.box/';

let routedHash = '#/';
let returnedOrgConnector: OrgConnectorReturn | null = null;
let returnedOpenRouter: OpenRouterReturn | null = null;

export function takeInitialOpenRouterReturn(): OpenRouterReturn | null {
  const back = returnedOpenRouter;
  returnedOpenRouter = null;
  return back;
}

export function takeInitialOrgConnectorReturn(): OrgConnectorReturn | null {
  const back = returnedOrgConnector;
  returnedOrgConnector = null;
  return back;
}

export const pathOfHash = (hash: string): string => {
  const path = hash.replace(/^#/, '');
  return path === '' ? '/' : path;
};

export function noteRouteHash(hash: string): void {
  routedHash = hash;
}

function currentHash(): string {
  return routedHash;
}

function replace(hash: string): void {
  routedHash = hash;
  if (WEB) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
  router.replace(pathOfHash(hash));
}

function push(hash: string): void {
  routedHash = hash;
  router.push(pathOfHash(hash));
}

function clearSearch(query: string): void {
  if (!WEB) return;
  window.history.replaceState(null, '', `${window.location.pathname}${query === '' ? '' : `?${query}`}${window.location.hash}`);
}

export function prepareLocation(): void {
  if (WEB) {
    const connector = readOrgConnectorReturn(window.location.search, window.location.hash);
    returnedOrgConnector = connector.result;
    if (connector.result !== null) window.history.replaceState(null, '', `${window.location.pathname}${connector.search}${connector.hash}`);
    const openrouter = readOpenRouterReturn(window.location.hash);
    returnedOpenRouter = openrouter.result;
    if (openrouter.result !== null) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${openrouter.hash}`);
    routedHash = window.location.hash;
  }
  const env: unknown = process.env.EXPO_PUBLIC_METRO_API_URL;
  const configured = typeof env === 'string' ? env.trim() : '';
  configurePlatform({
    apiBase: configured === '' ? HOSTED_API : configured,
    ...(WEB ? {} : { fetchNoRedirect: expoFetch }),
    signInReturn: () => (WEB ? `${window.location.origin}${window.location.pathname}` : WEB_HOME),
    location: {
      hash: currentHash,
      search: () => (WEB ? window.location.search : ''),
      origin: () => (WEB ? window.location.origin : WEB_HOME.slice(0, -1)),
      replace,
      push,
      clearSearch,
    },
  });
}
