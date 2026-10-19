import type { OrganizationAvatars } from '../src/avatar.ts';

export function memoryOrgAvatars(): OrganizationAvatars & { held: Map<string, string> } {
  const held = new Map<string, string>();
  return {
    held,
    avatars: (ids) => Promise.resolve(new Map(ids.flatMap((id) => {
      const avatar = held.get(id);
      return avatar === undefined ? [] : [[id, avatar] as const];
    }))),
    setAvatar: (organization, avatar) => {
      if (avatar === null) held.delete(organization);
      else held.set(organization, avatar);
      return Promise.resolve();
    },
  };
}
