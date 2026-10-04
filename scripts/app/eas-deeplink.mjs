#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const raw = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const records = Array.isArray(raw) ? raw : raw.updates ?? [raw];
const rec = records.find((r) => r?.group) ?? records[0];
const group = rec?.group;
const projectId = rec?.projectId ?? rec?.project?.id;

if (!group || !projectId) {
  console.error('eas-deeplink: no group or project id in the eas update output');
  console.error(JSON.stringify(raw).slice(0, 500));
  process.exit(1);
}

const manifest = `https://u.expo.dev/${projectId}/group/${group}`;
console.log(`deeplink=metro://expo-development-client/?url=${encodeURIComponent(manifest)}`);
console.log(`manifest=${manifest}`);
