import { v, type Validator } from './schema.js';

export type VerbKind = 'read' | 'mutate';

export type VerbOwner = 'core' | (string & {});

export interface VerbDecl {
  readonly name: string;
  readonly owner: VerbOwner;
  readonly kind: VerbKind;
  readonly guarded?: boolean;
  readonly inputSchema?: Validator<unknown>;
  readonly description: string;
  readonly example: string;
  readonly idempotent: boolean;
}

export const line = v.string({ min: 1 });
