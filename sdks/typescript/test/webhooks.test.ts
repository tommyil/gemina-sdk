// unwrapWebhook against the shared vectors (HELPER_CONTRACT section 6).
// Mirrors sdks/python/tests/test_webhooks.py case for case.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DocumentProcessingResultOutDTOFromJSON,
  GeminaError,
  GeminaWebhookVerificationError,
  isExtractionCompleted,
  isWebhookTest,
  unwrapWebhook,
  type UnwrapWebhookOptions,
  type WebhookHeaders,
} from '../src/index';

interface Vector {
  name: string;
  secret: string;
  now: number;
  headers: Record<string, string>;
  body: string;
  expectType?: string | null;
  reason?: string;
}
interface VectorFile {
  valid: Vector[];
  invalid: Vector[];
}

const here = dirname(fileURLToPath(import.meta.url));
const load = (name: string): VectorFile =>
  JSON.parse(readFileSync(resolve(here, '../../../testdata', name), 'utf8'));
const VECTORS = load('webhook_test_vectors.json');
const TYPED = load('webhook_typed_vectors.json');

const named = (list: Vector[], name: string): Vector => {
  const found = list.find((v) => v.name === name);
  if (!found) throw new Error(`no vector named ${name}`);
  return found;
};
const unwrap = (v: Vector, options: UnwrapWebhookOptions = {}, headers: WebhookHeaders = v.headers) =>
  unwrapWebhook(v.body, headers, v.secret, { now: () => v.now, ...options });

/** The reason a rejected call carried; fails the test if it resolved or threw anything else. */
async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GeminaWebhookVerificationError);
    expect(error).toBeInstanceOf(GeminaError);
    return (error as GeminaWebhookVerificationError).reason;
  }
  throw new Error('expected the delivery to be rejected');
}

/** The vector's headers, re-signed for other body bytes (for bodies JSON text cannot carry). */
function signed(v: Vector, body: Uint8Array): Record<string, string> {
  const headers = Object.fromEntries(Object.entries(v.headers).map(([k, value]) => [k.toLowerCase(), value]));
  const key = Buffer.from(v.secret.slice('whsec_'.length), 'base64');
  const mac = createHmac('sha256', key)
    .update(`${headers['webhook-id']}.${headers['webhook-timestamp']}.`)
    .update(body)
    .digest('base64');
  return { ...headers, 'webhook-signature': `v1,${mac}` };
}

const utf8 = named(VECTORS.valid, 'extraction-completed-utf8-body');
const otherSignature = `v1,${Buffer.alloc(32).toString('base64')}`;

describe('unwrapWebhook', () => {
  it('loads every vector', () => {
    // A truncated or mis-copied file would otherwise shrink the cases below silently.
    expect([VECTORS.valid.length, VECTORS.invalid.length]).toEqual([12, 30]);
    expect([TYPED.valid.length, TYPED.invalid.length]).toEqual([3, 3]);
  });

  it.each([...VECTORS.valid, ...TYPED.valid].map((v) => [v.name, v] as const))('verifies %s', async (_, v) => {
    const event = await unwrap(v);
    expect(event.type).toBe(v.expectType);
    // The id header specifically: "one of the header values" would also pass for the timestamp.
    const idHeader = Object.entries(v.headers).find(([k]) => k.toLowerCase() === 'webhook-id');
    expect(event.id).toBe(idHeader?.[1]);
  });

  it.each([...VECTORS.invalid, ...TYPED.invalid].map((v) => [v.name, v] as const))('rejects %s', async (_, v) => {
    expect(await reasonOf(unwrap(v))).toBe(v.reason);
  });

  it('treats bytes and a string the same', async () => {
    const asBytes = await unwrapWebhook(new TextEncoder().encode(utf8.body), utf8.headers, utf8.secret, {
      now: () => utf8.now,
    });
    expect(asBytes.raw).toEqual((await unwrap(utf8)).raw);
  });

  it('types the extraction.completed data', async () => {
    const event = await unwrap(utf8);
    if (!isExtractionCompleted(event)) throw new Error('expected extraction.completed');
    expect(event.data.correlationId).toBe('3f2b6c1e-0d4a-4a57-9a43-1f0e5a7b9c10');
    expect(event.data.externalId).toBe('חשבונית-2291');
    expect(event.data.resultIncluded).toBe(false);
    expect(event.data.result).toBeUndefined();
    expect(event.timestamp).toBe(JSON.parse(utf8.body).timestamp);
  });

  it('parses an included result as the polling path parses it', async () => {
    const event = await unwrap(named(TYPED.valid, 'extraction-completed-with-result'));
    if (!isExtractionCompleted(event)) throw new Error('expected extraction.completed');
    expect(event.data.error).toBeUndefined();
    const raw = event.raw as { data: { result: { data: { extractions: { meta: Record<string, unknown> }[] } } } };
    // The wire values, which every language asserts the same way:
    const wireMeta = raw.data.result.data.extractions[0].meta;
    expect(wireMeta.purgeReason).toBeNull();
    expect(wireMeta.purgeAt).toBe('2026-08-03T17:20:13.180624');
    // The typed side: exactly what the polling path's parser returns for the same JSON.
    expect(event.data.result).toEqual(DocumentProcessingResultOutDTOFromJSON(raw.data.result));
    const meta = event.data.result?.data?.extractions?.[0].meta;
    expect(meta?.purgeReason).toBeNull();
    expect(meta?.purgeAt).toEqual(new Date('2026-08-03T17:20:13.180624')); // a Date keeps milliseconds only
    expect(event.data.result?.meta.documentId).toBe('28677df7-033a-409f-8b70-1568ddd17ea0');
  });

  it('keeps an enum value added to the API later, as polling does', async () => {
    const event = await unwrap(named(TYPED.valid, 'extraction-completed-with-unknown-enum-values'));
    if (!isExtractionCompleted(event)) throw new Error('expected extraction.completed');
    // TypeScript enums are string unions: the value that was sent is kept as it is.
    expect(event.data.result?.status).toBe('queued');
    expect(event.data.result?.data?.extractions?.[0].meta.modelType).toBe('nova');
    const raw = event.raw as { data: { result: unknown } };
    expect(event.data.result).toEqual(DocumentProcessingResultOutDTOFromJSON(raw.data.result));
  });

  it('keeps a value of another JSON type as sent, as documented (TypeScript checks no value types)', async () => {
    const v = named(TYPED.valid, 'extraction-completed-with-unknown-enum-values');
    const body = JSON.parse(v.body);
    body.data.result.data.extractions[0].meta.modelType = 42;
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    const event = await unwrapWebhook(bytes, signed(v, bytes), v.secret, { now: () => v.now });
    if (!isExtractionCompleted(event)) throw new Error('expected extraction.completed');
    expect(event.data.result?.data?.extractions?.[0].meta.modelType as unknown).toBe(42);
  });

  it('types an error envelope', async () => {
    const event = await unwrap(named(TYPED.valid, 'extraction-completed-with-error'));
    if (!isExtractionCompleted(event)) throw new Error('expected extraction.completed');
    expect(event.data.result).toBeUndefined();
    expect(event.data.status).toBe('failed');
    expect(event.data.error?.errors?.[0]).toMatchObject({ error_code: 'PROCESSING_ERROR' });
  });

  it('types the test event message', async () => {
    const event = await unwrap(named(VECTORS.valid, 'test-event'));
    if (!isWebhookTest(event)) throw new Error('expected webhook.test');
    expect(event.data.message).toBe('This is a test event from Gemina.');
  });

  it('keeps the type and data of an unknown event type', async () => {
    const event = await unwrap(named(VECTORS.valid, 'unknown-future-event-type'));
    expect(event.type).toBe('invoice.archived');
    expect(event.data).toEqual({ documentId: '9b1d4f0a-6c2e-4d8b-8f31-5a7c0e2b4d66', nested: { n: 1 } });
  });

  it('returns a body with no type raw, with a null type', async () => {
    const event = await unwrap(named(VECTORS.valid, 'standard-webhooks-published-example'));
    expect(event.type).toBeNull();
    expect(event.raw).toEqual({ test: 2432232314 });
  });

  it('does not look a type name up on the prototype chain', async () => {
    const body = new TextEncoder().encode('{"type":"constructor","data":{"x":1}}');
    const event = await unwrapWebhook(body, signed(utf8, body), utf8.secret, { now: () => utf8.now });
    expect(event.type).toBe('constructor');
    expect(event.data).toEqual({ x: 1 });
  });

  it('honours a custom tolerance', async () => {
    const event = await unwrap(named(VECTORS.invalid, 'timestamp-too-old'), { toleranceSeconds: 600 });
    expect(event.type).toBe('extraction.completed');
  });

  it('copies the caller\'s buffer before the first await', async () => {
    // The regression for the async gap: the body must not be read again after an await.
    const buffer = Buffer.from(utf8.body, 'utf8');
    const pending = unwrapWebhook(buffer, utf8.headers, utf8.secret, { now: () => utf8.now });
    buffer.fill(0);
    expect((await pending).raw).toMatchObject({ type: 'extraction.completed' });
  });

  it('copies the caller\'s buffer before anything else reads it', async () => {
    // The clock runs after the copy and before the HMAC, so overwriting from inside it fails
    // any helper that signs or parses the caller's buffer.
    const buffer = Buffer.from(utf8.body, 'utf8');
    const event = await unwrapWebhook(buffer, utf8.headers, utf8.secret, {
      now: () => {
        buffer.fill(0x78);
        return utf8.now;
      },
    });
    expect(event.raw).toMatchObject({ type: 'extraction.completed' });
  });

  it.each([
    ['webhook-id', 'Webhook-Id'],
    ['Webhook-Id', 'webhook-id'],
  ])('judges a repeated header the same in either order (%s, %s)', async (first, second) => {
    const real = utf8.headers['webhook-id'];
    const { 'webhook-id': _, ...rest } = utf8.headers;
    expect((await unwrap(utf8, {}, { [first]: real, [second]: real, ...rest })).id).toBe(real);
    expect(await reasonOf(unwrap(utf8, {}, { [first]: real, [second]: 'evt_other', ...rest }))).toBe('ambiguous_header');
  });

  it('parses the verified bytes of an ArrayBuffer the caller changes after the call', async () => {
    const encoded = new TextEncoder().encode(utf8.body);
    const arrayBuffer = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
    const pending = unwrapWebhook(arrayBuffer, utf8.headers, utf8.secret, { now: () => utf8.now });
    new Uint8Array(arrayBuffer).fill(0x20); // JSON whitespace: a parse of these bytes would fail
    const event = await pending;
    expect(event.raw).toEqual(JSON.parse(utf8.body));
  });

  it.each(['ArrayBuffer', 'DataView'] as const)('reports a %s over a detached buffer as invalid_body', async (kind) => {
    // A body transferred to a worker leaves its ArrayBuffer detached: there are no bytes left to read.
    const encoded = new TextEncoder().encode(utf8.body);
    const buffer = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
    const view = new DataView(buffer);
    structuredClone(buffer, { transfer: [buffer] });
    const body = kind === 'ArrayBuffer' ? buffer : view;
    expect(await reasonOf(unwrapWebhook(body, utf8.headers, utf8.secret, { now: () => utf8.now }))).toBe('invalid_body');
  });

  it('copies a view over part of a larger buffer, and only that part', async () => {
    const encoded = new TextEncoder().encode(utf8.body);
    const larger = new Uint8Array(encoded.length + 8);
    larger.set(encoded, 4);
    const view = new DataView(larger.buffer, 4, encoded.length);
    const pending = unwrapWebhook(view, utf8.headers, utf8.secret, { now: () => utf8.now });
    larger.fill(0);
    expect((await pending).raw).toEqual(JSON.parse(utf8.body));
  });

  it('judges a repeat that a library already joined the same', async () => {
    const signature = utf8.headers['webhook-signature'];
    expect((await unwrap(utf8, {}, { ...utf8.headers, 'webhook-signature': `${signature}, ${signature}` })).type)
      .toBe('extraction.completed');
    for (const joined of [`${otherSignature}, ${signature}`, `${signature}, ${otherSignature}`]) {
      expect(await reasonOf(unwrap(utf8, {}, { ...utf8.headers, 'webhook-signature': joined }))).toBe('ambiguous_header');
    }
  });

  it('takes each item of a header given as a list', async () => {
    const signature = utf8.headers['webhook-signature'];
    expect((await unwrap(utf8, {}, { ...utf8.headers, 'webhook-signature': [signature, signature] })).type)
      .toBe('extraction.completed');
    expect(await reasonOf(unwrap(utf8, {}, { ...utf8.headers, 'webhook-signature': [signature, otherSignature] })))
      .toBe('ambiguous_header');
  });

  it('reads a fetch Headers object', async () => {
    expect((await unwrap(utf8, {}, new Headers(utf8.headers))).type).toBe('extraction.completed');
  });

  it('refuses a repeated header in a fetch Headers object, which joins it with ", "', async () => {
    for (const order of [[utf8.headers['webhook-signature'], otherSignature], [otherSignature, utf8.headers['webhook-signature']]]) {
      const headers = new Headers(utf8.headers);
      headers.set('webhook-signature', order[0]);
      headers.append('webhook-signature', order[1]);
      expect(await reasonOf(unwrap(utf8, {}, headers))).toBe('ambiguous_header');
    }
    const same = new Headers(utf8.headers);
    same.append('webhook-signature', utf8.headers['webhook-signature']);
    expect((await unwrap(utf8, {}, same)).type).toBe('extraction.completed');
  });

  it('reads a Map, and answers missing_header when it lacks a header', async () => {
    const all: Map<string, string> = new Map(Object.entries(utf8.headers)); // typed as a caller would, no cast
    expect((await unwrap(utf8, {}, all)).type).toBe('extraction.completed');
    all.delete('webhook-id');
    expect(await reasonOf(unwrap(utf8, {}, all))).toBe('missing_header');
  });

  it('folds the names in a Map by ASCII case, as for a plain object', async () => {
    const { 'webhook-id': id, ...rest } = utf8.headers;
    const mixed = new Map<string, string>([['Webhook-Id', id], ...Object.entries(rest)]);
    expect((await unwrap(utf8, {}, mixed)).id).toBe(id);
    const conflicting = new Map<string, string>([['webhook-id', id], ['Webhook-Id', 'evt_other'], ...Object.entries(rest)]);
    expect(await reasonOf(unwrap(utf8, {}, conflicting))).toBe('ambiguous_header');
    const repeated = new Map<string, string[]>([['webhook-id', [id, id]], ...Object.entries(rest).map(([k, v]) => [k, [v]] as [string, string[]])]);
    expect((await unwrap(utf8, {}, repeated)).id).toBe(id);
  });

  it('treats options: null like no options', async () => {
    // The real clock then finds the 2026 vector too old: the point is that nothing else is thrown.
    expect(await reasonOf(unwrapWebhook(utf8.body, utf8.headers, utf8.secret, null as unknown as UnwrapWebhookOptions)))
      .toBe('timestamp_out_of_tolerance');
  });

  it.each(['webhoo\u212a-id', 'webhook-\u0131d'])('folds header names by ASCII case only (%s)', async (lookalike) => {
    // U+212A KELVIN SIGN lower-cases to "k" and U+0131 DOTLESS I upper-cases to "I" under
    // Unicode rules; header names are ASCII.
    const { 'webhook-id': id, ...rest } = utf8.headers;
    expect(await reasonOf(unwrap(utf8, {}, { [lookalike]: id, ...rest }))).toBe('missing_header');
  });

  it.each([
    ['toleranceSeconds NaN', { toleranceSeconds: NaN }],
    ['toleranceSeconds Infinity', { toleranceSeconds: Infinity }],
    ['toleranceSeconds -1', { toleranceSeconds: -1 }],
    ['now NaN', { now: () => NaN }],
    ['now Infinity', { now: () => Infinity }],
    ['now -Infinity', { now: () => -Infinity }],
  ] as const)('never switches the age check off: %s', async (_, options) => {
    // An expired delivery, correctly signed. Number(process.env.UNSET) is NaN in real code.
    expect(await reasonOf(unwrap(named(VECTORS.invalid, 'timestamp-too-old'), options)))
      .toBe('timestamp_out_of_tolerance');
  });

  it('verifies the substituted bytes of text that is not well formed', async () => {
    // TextEncoder replaces an unpaired surrogate, so the signature no longer matches.
    expect(await reasonOf(unwrapWebhook(`${utf8.body}\ud800`, utf8.headers, utf8.secret, { now: () => utf8.now })))
      .toBe('no_matching_signature');
  });

  it('rejects a signed body that is not UTF-8', async () => {
    const body = new Uint8Array([...new TextEncoder().encode('{"type":"extraction.completed","data":"'), 0xff, 0x22, 0x7d]);
    expect(await reasonOf(unwrapWebhook(body, signed(utf8, body), utf8.secret, { now: () => utf8.now })))
      .toBe('invalid_body');
  });

  it('treats an unset secret as an invalid secret', async () => {
    // process.env.GEMINA_WEBHOOK_SECRET is undefined when the variable is not set.
    const secret = process.env.GEMINA_SDK_TEST_UNSET_VARIABLE as string;
    expect(await reasonOf(unwrapWebhook(utf8.body, utf8.headers, secret, { now: () => utf8.now })))
      .toBe('invalid_secret');
  });

  it('lets only the verification error leave the helper', async () => {
    for (const headers of [{}, { 'webhook-id': undefined }, { 'webhook-timestamp': '9'.repeat(400) }]) {
      await reasonOf(unwrapWebhook(utf8.body, headers, utf8.secret));
    }
    // No body and no headers at all, as the C# and Java suites also pass (plain JavaScript callers can).
    for (const headers of [null, undefined]) {
      await reasonOf(unwrapWebhook(utf8.body, headers as unknown as WebhookHeaders, utf8.secret));
    }
    for (const body of [null, undefined]) {
      await reasonOf(unwrapWebhook(body as unknown as string, utf8.headers, utf8.secret, { now: () => utf8.now }));
    }
  });

  it('narrows to the typed data without a cast', async () => {
    const test = named(VECTORS.valid, 'test-event');
    const typed = named(TYPED.valid, 'extraction-completed-with-result');
    const event = await unwrapWebhook(test.body, test.headers, test.secret, { now: () => test.now });
    if (isWebhookTest(event)) {
      const message: string = event.data.message;
      expect(message).toContain('test event');
    } else {
      throw new Error('expected a test event');
    }
    const completed = await unwrapWebhook(typed.body, typed.headers, typed.secret, { now: () => typed.now });
    if (!isExtractionCompleted(completed)) throw new Error('expected extraction.completed');
    const included: boolean = completed.data.resultIncluded;
    expect(included).toBe(true);
  });
});
