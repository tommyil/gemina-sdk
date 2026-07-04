// Live smoke test for the BUILT package (run `npm run build` first):
//   GEMINA_BASE_URL=https://api.staging.gemina.co GEMINA_API_KEY=... node smoke/smoke.mjs
import { GeminaClient, VERSION } from '../dist/index.js';

const baseUrl = process.env.GEMINA_BASE_URL || 'https://api.gemina.co';
const apiKey = process.env.GEMINA_API_KEY;

if (!apiKey) {
  console.error('GEMINA_API_KEY environment variable is required');
  process.exit(1);
}

console.log(`@gemina/sdk ${VERSION} smoke test against ${baseUrl}`);

try {
  const client = new GeminaClient(apiKey, baseUrl);
  const status = await client.retrieval.retrievalStatus();
  console.log('retrievalStatus() ->', JSON.stringify(status, null, 2));
  console.log('indexedDocuments:', status.indexedDocuments);
  if (typeof status.indexedDocuments !== 'number') {
    console.error('FAIL: indexedDocuments is not a number');
    process.exit(1);
  }
  console.log('OK');
} catch (error) {
  console.error('Smoke test failed:', error);
  if (error && typeof error === 'object' && 'response' in error && error.response) {
    try {
      console.error('Response body:', await error.response.text());
    } catch {
      // ignore secondary failures while reporting
    }
  }
  process.exit(1);
}
