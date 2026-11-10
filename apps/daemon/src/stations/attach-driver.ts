export type AttachStep = 'code' | 'password' | 'scan' | 'pair';

export interface AttachPrompt {
  step: AttachStep;
  prompt: string;
  qr?: string;
  pairingCode?: string;
}

export interface AttachOutcome {
  config: Record<string, unknown>;
  identity: Record<string, string>;
}

export interface DriverHooks {
  prompt: (p: AttachPrompt) => void;
  done: (o: AttachOutcome) => void;
  fail: (message: string) => void;
}

export interface StepInput {
  code?: unknown;
  password?: unknown;
}

export interface AttachDriver {
  submit: (input: StepInput) => Promise<void>;
  cancel: () => Promise<void>;
}

export interface StartedAttach {
  driver: AttachDriver;
  prompt: AttachPrompt;
}
