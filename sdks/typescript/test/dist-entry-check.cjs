// Runs one shared vector through the built CommonJS entry point (dist/index.cjs).
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { unwrapWebhook } = require('../dist/index.cjs');

const vectors = JSON.parse(readFileSync(resolve(__dirname, '../../../testdata/webhook_test_vectors.json'), 'utf8'));
const v = vectors.valid.find((x) => x.name === 'extraction-completed-utf8-body');
unwrapWebhook(v.body, v.headers, v.secret, { now: () => v.now }).then((event) => {
  if (event.type !== 'extraction.completed') throw new Error('CJS entry point failed to verify a vector');
  console.log(`cjs ok, global WebCrypto: ${globalThis.crypto && globalThis.crypto.subtle ? 'present' : 'absent (fallback used)'}`);
}).catch((error) => { console.error(error); process.exit(1); });
