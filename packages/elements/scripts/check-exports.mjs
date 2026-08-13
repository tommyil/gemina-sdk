#!/usr/bin/env node
/**
 * Build gate: every file path referenced from package.json's `exports` map
 * (plus main/module/types) must exist after the build. Catches the silent
 * failure mode where a tsup entry is renamed/dropped but the exports map
 * still advertises the old artifact — consumers would only find out at
 * install time. Wired into `npm run build` (after tsup) so CI's release
 * build enforces it forever.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));

const missing = [];
const checked = [];

/** Walk an exports-map value: strings are paths; objects are condition maps. */
function walk(value, trail) {
  if (typeof value === 'string') {
    checked.push(value);
    if (!existsSync(join(packageRoot, value))) {
      missing.push(`${trail}: ${value}`);
    }
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      walk(child, `${trail}[${key}]`);
    }
  }
}

walk(pkg.exports ?? {}, 'exports');
for (const key of ['main', 'module', 'types']) {
  if (typeof pkg[key] === 'string') {
    walk(pkg[key], key);
  }
}

if (checked.length === 0) {
  console.error('check-exports: package.json declares no export paths — refusing to pass vacuously');
  process.exit(1);
}
if (missing.length > 0) {
  console.error('check-exports: exports map entries missing from dist:');
  for (const entry of missing) {
    console.error(`  ${entry}`);
  }
  process.exit(1);
}
console.log(`check-exports: OK — all ${checked.length} exported paths exist`);
