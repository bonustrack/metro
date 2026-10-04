#!/usr/bin/env bun
const LITERAL = /^[A-Za-z0-9.-]$/;

const [branch] = process.argv.slice(2);
if (!branch) {
  console.error('usage: bun scripts/app/channel-key.mjs <branch>');
  process.exit(2);
}
process.stdout.write(
  Array.from(new TextEncoder().encode(branch), (byte) => {
    const character = String.fromCharCode(byte);
    return LITERAL.test(character) ? character : `_${byte.toString(16).padStart(2, '0')}`;
  }).join(''),
);
