let generation = 0;
let active = 0;
const listeners = new Set<() => void>();

export const enrollmentScopeIdentity = (): number => generation;
export const enrollmentRunning = (): boolean => active > 0;

export function subscribeEnrollmentScope(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function changed(): void {
  generation += 1;
  for (const listener of listeners) listener();
}

export function beginEnrollment(): () => void {
  active += 1;
  changed();
  return () => { active -= 1; changed(); };
}
