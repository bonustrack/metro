import { router } from 'expo-router';
import { routeHash } from '@metro-labs/client/route';
import type { Selection } from '@metro-labs/client/selection';
import { pathOfHash } from './location.js';

export const pathOf = (target: Selection): string => pathOfHash(routeHash(target));

export function go(target: Selection): void {
  router.push(pathOf(target));
}

export function goHash(hash: string): void {
  router.push(pathOfHash(hash));
}
