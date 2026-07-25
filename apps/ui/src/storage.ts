const STORAGE_KEY = 'metro.apiKey';

export function loadApiKey(): string | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored !== null && stored.length > 0 ? stored : null;
  } catch {
    return null;
  }
}

export function saveApiKey(apiKey: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, apiKey);
  } catch {
    return;
  }
}

export function clearApiKey(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    return;
  }
}
