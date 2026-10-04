import { Linking, Platform } from 'react-native';
import { logError } from './log.js';

export function openExternal(url: string): boolean {
  if (Platform.OS === 'web') return window.open(url, '_blank', 'noopener,noreferrer') !== null;
  Linking.openURL(url).catch(logError('open'));
  return true;
}

export function goExternal(url: string): void {
  if (Platform.OS === 'web') window.location.assign(url);
  else Linking.openURL(url).catch(logError('open'));
}
