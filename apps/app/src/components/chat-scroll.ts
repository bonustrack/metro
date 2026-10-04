export const atBottom = (): boolean => false;

export function toBottom(): void {
  atBottom();
}

export function keepOffset(): () => void {
  return toBottom;
}
