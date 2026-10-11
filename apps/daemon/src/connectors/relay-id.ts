export const orgRelayId = (id: string): string => `org-${id}`;
export const isOrgRelayId = (id: string): boolean => /^org-[A-Za-z0-9][A-Za-z0-9_-]{10}$/.test(id);
