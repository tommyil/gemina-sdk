// Live smoke test for the BUILT package (run `npm run build` first):
//   GEMINA_BASE_URL=https://api.staging.gemina.co GEMINA_API_KEY=... node smoke/smoke.mjs
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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
  const history = await client.chat.listChatSessions({ limit: 2 });
  console.log('listChatSessions() -> count:', history.count, 'sessions:', history.sessions.length);
  if (typeof history.count !== 'number') {
    console.error('FAIL: chat history count is not a number');
    process.exit(1);
  }
  // Add-on round trip is opt-in: it UPLOADS a document and spends credits, so
  // it must never run against production by accident. Enable it explicitly
  // against a staging key that has credits:
  //   GEMINA_SMOKE_ADD_ON=1 GEMINA_BASE_URL=https://api.staging.gemina.co \
  //   GEMINA_API_KEY=... node smoke/smoke.mjs
  if (process.env.GEMINA_SMOKE_ADD_ON) {
    const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'one-page.pdf');
    const bytes = await readFile(fixture);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    console.log('add-on: uploading one-page.pdf (ocr, praetorian) ...');
    const uploaded = await client.processDocument(blob, ['ocr'], { modelType: 'praetorian' });
    const documentId = uploaded.meta?.documentId;
    if (!documentId) {
      console.error('FAIL: upload result carried no documentId');
      process.exit(1);
    }
    console.log(`add-on: uploaded documentId=${documentId} status=${uploaded.status}`);

    console.log('add-on: addExtractionsAndWait([invoice_headers]) ...');
    const result = await client.addExtractionsAndWait(documentId, ['invoice_headers']);
    if (result.meta?.documentId !== documentId) {
      console.error('FAIL: add-on result is for a different document');
      process.exit(1);
    }
    const n = result.data?.extractions?.length ?? 0;
    console.log(`add-on: terminal status=${result.status}, extractions on document=${n}`);
    if (n < 2) {
      console.error('FAIL: expected at least 2 extractions after the add-on');
      process.exit(1);
    }
    console.log('add-on: OK');
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
