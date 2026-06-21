import { stationByName } from './stations/registry.js';

export type VerbOwner = 'core' | (string & {});

const CORE_MUTATES: ReadonlySet<string> = new Set([
  'claim',
  'release',
  'webhook',
  'tunnel',
]);

export function mutateVerbs(owner: VerbOwner): ReadonlySet<string> {
  if (owner === 'core') return CORE_MUTATES;
  return stationByName(owner)?.mutates ?? new Set<string>();
}
