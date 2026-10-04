import { setStringAsync } from 'expo-clipboard';

export function copyText(value: string): Promise<boolean> {
  return setStringAsync(value).then(
    () => true,
    () => false,
  );
}
