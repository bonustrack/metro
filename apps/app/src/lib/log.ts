export function logError(where: string): (err: unknown) => void {
  return (err: unknown) => {
    if (__DEV__) console.warn(`[metro] ${where}`, err);
  };
}
