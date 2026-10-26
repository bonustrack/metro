import Constants from 'expo-constants';
import { buildInfo, type BuildInfo } from '@metro-labs/client/build';
import { str } from '@metro-labs/client/read';

const extra = (key: string): string => str(Constants.expoConfig?.extra?.[key]);

export const currentBuild = (): BuildInfo => buildInfo(extra('gitHash'), extra('commitTime'));
