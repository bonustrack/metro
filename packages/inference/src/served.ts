export interface Served {
  connection: string;
  provider: string;
  model: string;
  at: string;
}

const last = new Map<string, Served>();

export const noteServed = (served: Served, scope = ''): void => {
  last.set(scope, served);
};

export const lastServed = (scope = ''): Served | null => last.get(scope) ?? null;

export const forgetServed = (): void => {
  last.clear();
};
