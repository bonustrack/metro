const NEAR_BOTTOM = 80;

const root = (): HTMLElement => document.documentElement;

export const atBottom = (): boolean => window.innerHeight + window.scrollY >= root().scrollHeight - NEAR_BOTTOM;

export function toBottom(): void {
  requestAnimationFrame(() => {
    window.scrollTo({ top: root().scrollHeight });
  });
}

export function keepOffset(): () => void {
  const height = root().scrollHeight;
  const y = window.scrollY;
  return () => {
    requestAnimationFrame(() => {
      window.scrollTo({ top: y + (root().scrollHeight - height) });
    });
  };
}
