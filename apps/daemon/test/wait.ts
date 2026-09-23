export const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function waitFor(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (predicate()) return;
    await settle(25);
  }
}
