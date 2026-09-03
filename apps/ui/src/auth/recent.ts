const RECENT_KEY = 'metro.recentWallet';

export function readRecentWallet(): string | null {
  try {
    const value = window.localStorage.getItem(RECENT_KEY);
    return value !== null && value !== '' ? value : null;
  } catch {
    return null;
  }
}

export function storeRecentWallet(id: string): void {
  try {
    window.localStorage.setItem(RECENT_KEY, id);
  } catch {
    return;
  }
}
