import madge from 'madge';
import { madgeConfig } from '@stage-labs/config/madge';

const ROOTS = ['src'];

const res = await madge(ROOTS, madgeConfig);
const circular = res.circular();

if (circular.length === 0) {
  console.log('madge: no circular dependencies found across', ROOTS.length, 'source roots.');
  process.exit(0);
}

console.log(`madge: ${circular.length} circular dependenc${circular.length === 1 ? 'y' : 'ies'} found:\n`);
for (const cycle of circular) console.log('  ' + cycle.join(' → '));
process.exit(1);
