const MAX_NAMES = 2000;

export interface NameBook {
  note(jid: string | null | undefined, name: string | null | undefined): void;
  get(jid: string): string | undefined;
}

export function makeNameBook(): NameBook {
  const names = new Map<string, string>();
  return {
    note(jid, name) {
      const clean = name?.trim() ?? '';
      if (!jid || clean === '') return;
      names.delete(jid);
      names.set(jid, clean);
      if (names.size > MAX_NAMES) {
        const oldest = names.keys().next().value;
        if (oldest !== undefined) names.delete(oldest);
      }
    },
    get: (jid) => names.get(jid),
  };
}

export const phoneOf = (jid: string | null | undefined): string | undefined => {
  const digits = /^(\d{6,})(?::\d+)?@s\.whatsapp\.net$/.exec(jid ?? '')?.[1];
  return digits === undefined ? undefined : `+${digits}`;
};
