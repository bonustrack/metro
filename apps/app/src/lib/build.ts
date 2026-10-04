import Constants from 'expo-constants';
import { buildInfo, type BuildInfo } from '@metro-labs/client/build';

function extra(key: string): string {
  const value: unknown = Constants.expoConfig?.extra?.[key];
  return typeof value === 'string' ? value : '';
}

export const currentBuild = (now = Date.now()): BuildInfo => buildInfo(extra('gitHash'), extra('commitTime'), now);
