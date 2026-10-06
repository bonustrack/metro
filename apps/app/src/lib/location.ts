import { Platform } from 'react-native';
import { router } from 'expo-router';
import { fetch as expoFetch } from 'expo/fetch';
import { configurePlatform, HOSTED_API } from '@metro-labs/client/platform';

const WEB = Platform.OS === 'web';
const WEB_HOME = 'https://metro.box/';

let nativeHash = '#/';

export const pathOfHash = (hash: string): string => {
  const path = hash.replace(/^#/, '');
  return path === '' ? '/' : path;
};

export function noteRouteHash(hash: string): void {
  nativeHash = hash;
}

function currentHash(): string {
  return WEB ? window.location.hash : nativeHash;
}

function replace(hash: string): void {
  if (WEB) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
  else nativeHash = hash;
  router.replace(pathOfHash(hash));
}

function push(hash: string): void {
  if (!WEB) nativeHash = hash;
  router.push(pathOfHash(hash));
}

function clearSearch(query: string): void {
  if (!WEB) return;
  window.history.replaceState(null, '', `${window.location.pathname}${query === '' ? '' : `?${query}`}${window.location.hash}`);
}

export function prepareLocation(): void {
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
