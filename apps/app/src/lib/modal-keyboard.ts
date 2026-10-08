export function modalKeyboardInset(platform: string, height: number, top: number | null): number {
  return platform === 'ios' && top !== null ? Math.max(0, height - top) : 0;
}
