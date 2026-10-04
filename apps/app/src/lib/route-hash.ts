import { Platform } from 'react-native';
import { useGlobalSearchParams, usePathname } from 'expo-router';
import { routeSelection } from '@metro-labs/client/route';
import type { Selection } from '@metro-labs/client/selection';
import { noteRouteHash } from './location.js';

const ROUTE_PARAMS = new Set(['path']);

function queryOf(params: Record<string, string | string[] | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (ROUTE_PARAMS.has(key) || value === undefined) continue;
    for (const each of Array.isArray(value) ? value : [value]) query.append(key, each);
  }
  const text = query.toString();
  return text === '' ? '' : `?${text}`;
}

function sameRoute(hash: string, routed: string): boolean {
  try {
    return decodeURIComponent(hash) === decodeURIComponent(routed);
  } catch {
    return false;
  }
}

export function useRouteHash(): string {
  const pathname = usePathname();
  const params = useGlobalSearchParams();
  const routed = `#${pathname}${queryOf(params)}`;
  if (Platform.OS === 'web' && sameRoute(window.location.hash, routed)) return window.location.hash;
  return routed;
}

export function useSelection(): Selection {
  const hash = useRouteHash();
  noteRouteHash(hash);
  return routeSelection(hash);
}
