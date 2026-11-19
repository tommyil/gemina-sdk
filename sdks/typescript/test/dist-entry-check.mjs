// Runs one shared vector through the built ESM entry point (dist/index.js).
import { readFileSync } from 'node:fs';
import { unwrapWebhook } from '../dist/index.js';

const vectors = JSON.parse(readFileSync(new URL('../../../testdata/webhook_test_vectors.json', import.meta.url), 'utf8'));
const v = vectors.valid.find((x) => x.name === 'extraction-completed-utf8-body');
const event = await unwrapWebhook(v.body, v.headers, v.secret, { now: () => v.now });
if (event.type !== 'extraction.completed') throw new Error('ESM entry point failed to verify a vector');
console.log(`esm ok, global WebCrypto: ${globalThis.crypto?.subtle ? 'present' : 'absent (fallback used)'}`);
