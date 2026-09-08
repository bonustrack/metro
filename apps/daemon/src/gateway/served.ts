export interface Served {
  provider: string;
  model: string;
  at: string;
}

let last: Served | null = null;

export const noteServed = (served: Served): void => {
  last = served;
};

export const lastServed = (): Served | null => last;

export const forgetServed = (): void => {
  last = null;
};
