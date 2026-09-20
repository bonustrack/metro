import { randomUUID } from 'node:crypto';

export const CODE_ASSIST_BASE = 'https://cloudcode-pa.googleapis.com';
export const CODE_ASSIST_DAILY = 'https://daily-cloudcode-pa.googleapis.com';
export const API = 'v1internal';
export const APP_VERSION = '2.0.3';
export const CLIENT_VERSION = '1.110.0';
export const CLIENT_NAME = 'antigravity';
export const IDE_TYPE = 9;
export const PLUGIN_TYPE = 2;
export const SYSTEM_PREFIX =
  'You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.**Absolute paths only****Proactiveness**';

const PLATFORMS: Record<string, number> = { 'darwin-x64': 1, 'darwin-arm64': 2, 'linux-x64': 3, 'linux-arm64': 4, 'win32-x64': 5 };

const osName = (): string => (process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux');

export const platformCode = (): number => PLATFORMS[`${process.platform}-${process.arch}`] ?? 0;

export const clientMetadata = (project: string | null): Record<string, unknown> => ({
  ideType: IDE_TYPE,
  platform: platformCode(),
  pluginType: PLUGIN_TYPE,
  ...(project === null ? {} : { duetProject: project }),
});

export const clientHeaders = (): Record<string, string> => ({
  'user-agent': `${CLIENT_NAME}/${APP_VERSION} ${osName()}/${process.arch}`,
  'x-client-name': CLIENT_NAME,
  'x-client-version': CLIENT_VERSION,
  'x-goog-api-client': 'gl-node/18.18.2 fire/0.8.6 grpc/1.10.x',
});

export type Bases = string | string[];

const listed = (override: Bases): string[] => (typeof override === 'string' ? [override] : override);

export const generateBases = (override?: Bases): string[] => (override === undefined ? [CODE_ASSIST_DAILY, CODE_ASSIST_BASE] : listed(override));

export const setupBases = (override?: Bases): string[] => (override === undefined ? [CODE_ASSIST_BASE, CODE_ASSIST_DAILY] : listed(override));

export const requestId = (): string => `agent-${randomUUID()}`;

const sessionId = randomUUID();

export const machineSessionId = (): string => sessionId;
