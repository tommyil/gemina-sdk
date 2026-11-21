// Verify and parse an incoming Gemina webhook (HELPER_CONTRACT section 6).
// Hand-written; lives outside src/generated. No network, no GeminaClient.
import { GeminaWebhookVerificationError } from './errors';
import type { GeminaWebhookVerificationReason } from './errors';
import type { ExtractionCompletedEventData, WebhookTestEventData } from './generated';
import { ExtractionCompletedEventDataFromJSON, WebhookTestEventDataFromJSON } from './generated';

const SECRET_PREFIX = 'whsec_';
const DEFAULT_TOLERANCE_SECONDS = 300;
// Standard alphabet, padded, no whitespace. The same expression in every SDK.
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const TIMESTAMP = /^[0-9]{1,12}$/;

/**
 * Request headers: a fetch `Headers` object, a `Map`, Node's `IncomingHttpHeaders`, or a
 * plain object. Names are matched ignoring ASCII case in every form.
 */
export type WebhookHeaders =
  | { get(name: string): string | null }
  | ReadonlyMap<string, string | readonly string[] | undefined>
  | Record<string, string | string[] | undefined>;

export interface UnwrapWebhookOptions {
  /** Maximum distance in seconds between the clock and the webhook timestamp. Default 300. */
  toleranceSeconds?: number;
  /** Clock in seconds since the epoch; may return a fraction. Injectable for tests. */
  now?: () => number;
}

export interface WebhookEvent {
  /** The `webhook-id` header. The same on every retry: deduplicate on it. */
  id: string;
  /** `extraction.completed`, `webhook.test`, a type added later, or `null` when the body has no `type`. */
  type: string | null;
  /** When the event was recorded; the same on every retry. */
  timestamp: string | null;
  /** Typed for the known event types (narrow with the guards below); the parsed value otherwise, or `null` when the body has no `data`. */
  data: unknown;
  /** The whole parsed body. */
  raw: Record<string, unknown>;
}
export interface ExtractionCompletedWebhookEvent extends WebhookEvent {
  type: 'extraction.completed';
  data: ExtractionCompletedEventData;
}
export interface WebhookTestWebhookEvent extends WebhookEvent {
  type: 'webhook.test';
  data: WebhookTestEventData;
}

// Sound because unwrapWebhook never returns a known type with untyped data.
export function isExtractionCompleted(event: WebhookEvent): event is ExtractionCompletedWebhookEvent {
  return event.type === 'extraction.completed';
}
export function isWebhookTest(event: WebhookEvent): event is WebhookTestWebhookEvent {
  return event.type === 'webhook.test';
}

// Each known event type: the fields its data must hold, and the generated converter that types it.
const KNOWN: Record<string, { required: Record<string, 'string' | 'boolean'>; read: (json: unknown) => unknown }> = {
  'extraction.completed': {
    required: { correlationId: 'string', status: 'string', resultIncluded: 'boolean', resultPath: 'string' },
    read: ExtractionCompletedEventDataFromJSON,
  },
  'webhook.test': { required: { message: 'string' }, read: WebhookTestEventDataFromJSON },
};

const fail = (reason: GeminaWebhookVerificationReason, message: string, cause?: unknown) =>
  new GeminaWebhookVerificationError(reason, message, cause);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Header names are compared ignoring ASCII case only: toLowerCase() would also
// fold characters such as U+212A KELVIN SIGN to "k".
const asciiLower = (text: string) => text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

// Step 10: the required fields, and for extraction.completed a whole result or error, never both.
// The generated FromJSON functions do not check this: a result of {} comes back with holes.
function isComplete(type: string, data: unknown): boolean {
  if (!isObject(data)) return false;
  if (Object.entries(KNOWN[type].required).some(([field, kind]) => typeof data[field] !== kind)) return false;
  if (type !== 'extraction.completed') return true;
  const result = data.result ?? null;
  const error = data.error ?? null;
  if (result !== null && error !== null) return false;
  if (result !== null
      && !(isObject(result) && typeof result.status === 'string' && isObject(result.meta) && 'data' in result)) {
    return false;
  }
  return error === null || (isObject(error) && typeof error.status === 'string');
}

function header(headers: WebhookHeaders, name: string): string {
  const values: string[] = [];
  // A fetch Headers object has already joined repeated headers with ", ", and so has
  // Node for these names. No real value of these headers holds ", ", so splitting
  // there gives a joined repeat the same answer as separate entries.
  const add = (value: string) => {
    for (const part of value.split(', ')) if (!values.includes(part)) values.push(part);
  };
  // Only text is a header name or value: anything else (null, a number, an object) is skipped.
  const fromEntries = (entries: Iterable<[unknown, unknown]>) => {
    for (const [key, value] of entries) {
      if (typeof key !== 'string' || asciiLower(key) !== name) continue;
      for (const item of Array.isArray(value) ? value : [value]) if (typeof item === 'string') add(item);
    }
  };
  if (headers === null || headers === undefined) {
    // No headers at all (possible from plain JavaScript): judged like an empty set.
  } else if (headers instanceof Map) {
    // Map.get is case-sensitive: read every entry, as for a plain object.
    fromEntries(headers.entries());
  } else if (typeof (headers as { get?: unknown }).get === 'function') {
    // A fetch Headers object: get() ignores case and joins a repeat with ", ".
    const value: unknown = (headers as { get(n: string): unknown }).get(name);
    if (typeof value === 'string') add(value);
  } else {
    fromEntries(Object.entries(headers as Record<string, string | string[] | undefined>));
  }
  if (values.length === 0) throw fail('missing_header', `The ${name} header is missing.`);
  if (values.length > 1) throw fail('ambiguous_header', `The ${name} header was sent more than once with different values.`);
  return values[0];
}

// The return type names the buffer kind: WebCrypto's importKey takes a view
// over an ArrayBuffer, and a plain `Uint8Array` return type is too wide for it.
function decodeBase64(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!BASE64.test(text)) return undefined;
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

// A type tag, not `instanceof`: an ArrayBuffer made in another realm (a `vm` context, a jsdom
// test environment) fails `instanceof ArrayBuffer` and is still the raw bytes.
function isRawBuffer(value: unknown): value is ArrayBufferLike {
  const tag = Object.prototype.toString.call(value);
  return tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]';
}

// Step 1: one private copy of the body. `new Uint8Array(arrayBuffer)` would be a view over the
// caller's memory, so an ArrayBuffer or a view is copied explicitly, and only the bytes it covers.
function copyBody(body: unknown): Uint8Array<ArrayBuffer> {
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body == null) return new Uint8Array(0); // possible from plain JavaScript: judged like an empty body
  if (!isRawBuffer(body) && !ArrayBuffer.isView(body)) {
    // A parsed value is not the body: new Uint8Array(5) would be five zero bytes, and {} no bytes at all.
    throw fail('invalid_body', 'The webhook body must be the raw request bytes or text, not a parsed value.');
  }
  try {
    const source = ArrayBuffer.isView(body)
      ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
      : new Uint8Array(body);
    const copy = new Uint8Array(source.length);
    copy.set(source);
    return copy;
  } catch (error) {
    // A detached ArrayBuffer, or a view over one (a body transferred to a worker), throws a
    // TypeError when read: there are no bytes left to verify.
    throw fail('invalid_body', 'The webhook body cannot be read: its buffer was detached.', error);
  }
}

async function subtleCrypto(): Promise<SubtleCrypto> {
  const global = (globalThis as { crypto?: Crypto }).crypto;
  if (global?.subtle) return global.subtle;
  // Node 18 does not expose WebCrypto globally. The specifier is built at run
  // time so browser bundlers do not try to resolve a Node built-in.
  const nodeCrypto = 'node:crypto';
  const module = await import(/* @vite-ignore */ /* webpackIgnore: true */ nodeCrypto);
  return (module.webcrypto as Crypto).subtle;
}

// Steps 5 to 8: decode the secret, sign the received bytes, and find a matching v1 signature.
// Returns the bytes that were signed, the only copy of the body read from here on.
async function verifySignature(
  rawBody: Uint8Array<ArrayBuffer>, id: string, timestampText: string, signatureHeader: string, secret: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = typeof secret === 'string'
    ? decodeBase64(secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret)
    : undefined;
  if (key === undefined || key.length === 0) {   // not set, not base64, or an empty key anyone could sign with
    throw fail('invalid_secret', 'The signing secret is not valid: expected whsec_ followed by base64.');
  }

  const prefix = new TextEncoder().encode(`${id}.${timestampText}.`);
  const signed = new Uint8Array(prefix.length + rawBody.length);
  signed.set(prefix, 0);
  signed.set(rawBody, prefix.length);

  const subtle = await subtleCrypto();
  const cryptoKey = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = new Uint8Array(await subtle.sign('HMAC', cryptoKey, signed));

  let matched = false;
  for (const entry of signatureHeader.split(' ')) {
    const comma = entry.indexOf(',');
    if (comma < 0 || entry.slice(0, comma) !== 'v1') continue;
    const candidate = decodeBase64(entry.slice(comma + 1));
    // No early exit: keep the comparison count independent of position.
    if (candidate !== undefined && constantTimeEqual(candidate, expected)) matched = true;
  }
  if (!matched) throw fail('no_matching_signature', 'No signature in the webhook-signature header matches.');
  return signed.subarray(prefix.length);
}

// Step 9: exactly one JSON object, in UTF-8 without a byte order mark.
function parseBody(verifiedBody: Uint8Array): Record<string, unknown> {
  if (verifiedBody.length >= 3 && verifiedBody[0] === 0xef && verifiedBody[1] === 0xbb && verifiedBody[2] === 0xbf) {
    throw fail('invalid_body', 'The webhook body starts with a byte order mark.');
  }
  let parsed: unknown;
  try {
    // ignoreBOM keeps a byte order mark in the text instead of silently dropping it.
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(verifiedBody));
  } catch (error) {
    // These two calls read nothing but the body: whatever they throw (a TypeError for bytes
    // that are not UTF-8, a SyntaxError for text that is not JSON) is about the body.
    throw fail('invalid_body', 'The webhook body is not valid JSON.', error);
  }
  if (!isObject(parsed)) throw fail('invalid_body', 'The webhook body is not a JSON object.');
  return parsed;
}

// Step 10: a known event's data as its generated model; any other event's data as parsed.
function typeData(type: string | null, data: unknown): unknown {
  // hasOwnProperty: a body whose type is "constructor" must not find an inherited property.
  if (type === null || !Object.prototype.hasOwnProperty.call(KNOWN, type)) return data;
  if (!isComplete(type, data)) {
    throw fail('invalid_body', `The data of this ${type} event is missing a required field.`);
  }
  try {
    return KNOWN[type].read(data);
  } catch (error) {
    // The generated converters document no error set; the contract allows one type out.
    throw fail('invalid_body', `The data of this ${type} event could not be read.`, error);
  }
}

/**
 * Verify a webhook's signature and timestamp, then parse it.
 *
 * Pass the RAW request body exactly as received. A body that was parsed and
 * re-serialised will not verify: the signature covers the exact bytes.
 *
 * @throws GeminaWebhookVerificationError when the delivery is not verified or
 *   cannot be parsed; `reason` says why. No other error leaves this function
 *   for any body, header or secret.
 */
export async function unwrapWebhook(
  body: string | ArrayBuffer | ArrayBufferView,
  headers: WebhookHeaders,
  secret: string,
  options: UnwrapWebhookOptions = {},
): Promise<WebhookEvent> {
  // One private copy, taken BEFORE the first await: the caller may reuse its buffer at once.
  const rawBody = copyBody(body);
  options = options ?? {}; // null from plain JavaScript reads as no options

  const id = header(headers, 'webhook-id');
  const timestampText = header(headers, 'webhook-timestamp');
  const signatureHeader = header(headers, 'webhook-signature');

  if (!TIMESTAMP.test(timestampText)) {
    throw fail('invalid_timestamp', 'The webhook-timestamp header is not a whole number of seconds.');
  }
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const clock = (options.now ?? (() => Date.now() / 1000))();
  if (!Number.isFinite(clock) || !Number.isFinite(tolerance) || tolerance < 0) {
    // NaN compares false with everything: without this, an old delivery would pass.
    throw fail('timestamp_out_of_tolerance',
      'The clock or the tolerance is not a finite number, so the timestamp cannot be checked.');
  }
  if (Math.abs(Math.floor(clock) - Number(timestampText)) > tolerance) {
    throw fail('timestamp_out_of_tolerance',
      `The webhook timestamp is more than ${tolerance} seconds from the current time.`);
  }

  const verifiedBody = await verifySignature(rawBody, id, timestampText, signatureHeader, secret);
  const parsed = parseBody(verifiedBody);
  const type = typeof parsed.type === 'string' ? parsed.type : null;
  const timestamp = typeof parsed.timestamp === 'string' ? parsed.timestamp : null;
  return { id, type, timestamp, data: typeData(type, parsed.data ?? null), raw: parsed };
}
