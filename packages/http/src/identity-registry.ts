const subjects = new Map<string, string>();

export function authorizeIdentity(address: string, subject: string): void {
  subjects.set(address.toLowerCase(), subject.toLowerCase());
}

export function identitySubject(address: string): string | undefined {
  return subjects.get(address.toLowerCase());
}

export function resetIdentities(): void {
  subjects.clear();
}
