import { existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', 'dist', 'assets', '__node_modules');
const hidden = join(root, '.bun');
const published = join(root, '_bun');

if (existsSync(hidden)) {
  rmSync(published, { recursive: true, force: true });
  renameSync(hidden, published);
}
