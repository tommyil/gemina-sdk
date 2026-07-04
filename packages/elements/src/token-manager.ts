/**
 * GeminaTokenManager — in-memory holder for short-lived Gemina session
 * tokens, per the Document Intelligence token spec (PRD §6.11.1).
 *
 * Security model (the five footguns this file designs out):
 *
 * 1. **The API key never enters the browser.** The constructor throws if it
 *    is handed a raw string instead of a `fetchToken` callback, and
 *    `getToken()` rejects if the callback ever resolves with an
 *    API-key-shaped string (32 alphanumerics, no dots).
 * 2. **The token is never persisted.** No `localStorage`, `sessionStorage`,
 *    cookies, or IndexedDB anywhere in this package — the token lives only
 *    in memory, inside state that is not an own property of the instance.
 * 3. **The browser never asserts its own scope.** This manager carries no
 *    scope parameters at all; scope is signed into the token server-side.
 * 4. **No refresh token is held in the browser.** Renewal always goes back
 *    through the tenant's own authenticated backend via `fetchToken`.
 * 5. **The SDK cannot mint or widen TTL/scope.** This class only *stores*
 *    what the tenant backend minted; it has no code path to
 *    `POST /v1/sessions/token`.
 *
 * Storage choice: internal state (including the token) lives in a
 * module-scoped `WeakMap` keyed by the instance rather than in an ordinary
 * class field. An ordinary field — even a `#private` one via devtools — is
 * trivially discoverable by enumerating the instance; the WeakMap keeps the
 * token out of `Object.keys`, `JSON.stringify`, spread copies, and casual
 * inspection, and it is unreachable without a reference to both the WeakMap
 * (module-private) and the instance. This is hardening against accidental
 * exposure/serialization, not encryption: code running in the same realm
 * with a debugger can still read process memory. The upgrade path for
 * stronger isolation is a Web Worker (see PRD §6.11.1).
 *
 * SSR-safe: this module touches no `window`/`document` at import time and
 * starts no timers — refresh happens lazily inside `getToken()`, so an idle
 * manager consumes nothing and never keeps a Node process alive.
 */

/** What `fetchToken` must resolve with (mirror of the mint response). */
export interface FetchTokenResult {
  /** The raw session token (a JWT). Pass it WITHOUT a "Bearer " prefix. */
  token: string;
  /** Token lifetime in seconds, as returned by the mint endpoint. */
  expiresIn: number;
}

/** Constructor options for {@link GeminaTokenManager}. */
export interface GeminaTokenManagerOptions {
  /**
   * Callback that obtains a fresh session token from the TENANT'S OWN
   * backend (which in turn calls Gemina's `POST /v1/sessions/token` with
   * the API key, server-side). It must resolve with
   * `{ token, expiresIn }`. It must NEVER return a Gemina API key.
   */
  fetchToken: () => Promise<FetchTokenResult>;
  /**
   * How many seconds before the token's expiry `getToken()` starts
   * refreshing. Default 60 (the PRD's `exp − 60s` refresh point).
   */
  refreshSkewSeconds?: number;
}

/** Gemina API keys are exactly 32 alphanumerics with no prefix. */
const API_KEY_SHAPE = /^[A-Za-z0-9]{32}$/;

const API_KEY_ERROR =
  'GeminaTokenManager received an API-key-shaped credential (32 alphanumeric ' +
  'characters). Gemina API keys are master keys and must NEVER enter the ' +
  'browser: mint a short-lived session token on YOUR backend via ' +
  'POST /v1/sessions/token (sessions.mintRetrievalToken in @gemina/sdk) and ' +
  'return { token, expiresIn } from fetchToken instead.';

interface TokenState {
  fetchToken: () => Promise<FetchTokenResult>;
  refreshSkewMs: number;
  /** The cached raw token, or null when absent/invalidated. */
  token: string | null;
  /** Epoch ms after which the cached token is considered expired. */
  expiresAtMs: number;
  /** Shared in-flight refresh, so concurrent callers never stampede. */
  inFlight: Promise<string> | null;
  /** Bumped by invalidate(); stale refreshes must not repopulate the cache. */
  epoch: number;
}

// Module-private state store — see the header comment for why the token is
// deliberately NOT an own property of the instance.
const STATES = new WeakMap<GeminaTokenManager, TokenState>();

function getState(manager: GeminaTokenManager): TokenState {
  const state = STATES.get(manager);
  if (state === undefined) {
    throw new Error(
      'GeminaTokenManager state missing — was the instance constructed normally? ' +
        '(Object.create/deserialization is not supported.)',
    );
  }
  return state;
}

/**
 * Validate what `fetchToken` resolved with and return the raw token.
 * Rejects API-key-shaped strings and anything that is not JWT-shaped.
 */
function validateFetchedToken(result: FetchTokenResult): string {
  if (result === null || typeof result !== 'object') {
    throw new Error(
      'GeminaTokenManager: fetchToken must resolve with { token, expiresIn } ' +
        `(got ${result === null ? 'null' : typeof result}).`,
    );
  }
  const { token, expiresIn } = result;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(
      'GeminaTokenManager: fetchToken resolved without a token string. ' +
        'Return { token, expiresIn } from the mint response.',
    );
  }
  if (API_KEY_SHAPE.test(token)) {
    throw new Error(API_KEY_ERROR);
  }
  // Session tokens are JWTs: exactly three non-empty dot-separated segments.
  const segments = token.split('.');
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
    throw new Error(
      'GeminaTokenManager: fetchToken resolved with a value that is not a ' +
        'session token. Gemina session tokens are JWTs (three dot-separated ' +
        'segments); return the `token` field from POST /v1/sessions/token.',
    );
  }
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error(
      'GeminaTokenManager: fetchToken resolved with an invalid expiresIn ' +
        `(${String(expiresIn)}). Return the mint response's expiresIn (seconds > 0).`,
    );
  }
  return token;
}

/**
 * Holds a short-lived Gemina session token in memory and keeps it fresh.
 *
 * ```ts
 * const tokenManager = new GeminaTokenManager({
 *   // YOUR backend endpoint — it holds the API key and mints the token.
 *   fetchToken: async () => {
 *     const res = await fetch("/api/gemina-session", { method: "POST" });
 *     if (!res.ok) throw new Error("Failed to mint Gemina session token");
 *     return res.json(); // { token, expiresIn }
 *   },
 * });
 * ```
 *
 * - `getToken()` fetches lazily on first use, then auto-refreshes when the
 *   cached token is within `refreshSkewSeconds` of expiry. Concurrent
 *   callers share a single in-flight fetch.
 * - `invalidate()` drops the cache so the next `getToken()` refetches
 *   (use after a 401).
 * - No timers run while idle; nothing is ever written to storage.
 */
export class GeminaTokenManager {
  constructor(options: GeminaTokenManagerOptions) {
    if (typeof options === 'string') {
      // Someone did `new GeminaTokenManager("<api key or token>")`.
      throw new Error(
        API_KEY_SHAPE.test(options)
          ? API_KEY_ERROR
          : 'GeminaTokenManager takes { fetchToken } — a callback that asks ' +
              'YOUR backend for a fresh session token — not a raw string. ' +
              'Never pass a Gemina API key to browser code.',
      );
    }
    if (options === null || typeof options !== 'object') {
      throw new Error(
        'GeminaTokenManager requires an options object: new GeminaTokenManager({ fetchToken }).',
      );
    }
    const { fetchToken, refreshSkewSeconds = 60 } = options;
    if (typeof fetchToken === 'string') {
      throw new Error(
        (API_KEY_SHAPE.test(fetchToken) ? `${API_KEY_ERROR} ` : '') +
          'GeminaTokenManager: fetchToken must be a function returning ' +
          'Promise<{ token, expiresIn }>, not a string.',
      );
    }
    if (typeof fetchToken !== 'function') {
      throw new Error(
        'GeminaTokenManager: fetchToken is required and must be a function ' +
          'returning Promise<{ token, expiresIn }>.',
      );
    }
    if (
      typeof refreshSkewSeconds !== 'number' ||
      !Number.isFinite(refreshSkewSeconds) ||
      refreshSkewSeconds < 0
    ) {
      throw new Error(
        `GeminaTokenManager: refreshSkewSeconds must be a non-negative number (got ${String(
          refreshSkewSeconds,
        )}).`,
      );
    }

    STATES.set(this, {
      fetchToken,
      refreshSkewMs: refreshSkewSeconds * 1000,
      token: null,
      expiresAtMs: 0,
      inFlight: null,
      epoch: 0,
    });
  }

  /**
   * Return a valid session token, fetching or refreshing as needed.
   *
   * A cached token is reused until `now >= expiry - refreshSkewSeconds`
   * (expiry computed as `Date.now() + expiresIn * 1000` at fetch time).
   * All concurrent callers during a refresh share ONE in-flight fetch.
   * A failed fetch is not cached — the next call retries.
   */
  getToken(): Promise<string> {
    const state = getState(this);

    if (state.token !== null && Date.now() < state.expiresAtMs - state.refreshSkewMs) {
      return Promise.resolve(state.token);
    }

    if (state.inFlight !== null) {
      return state.inFlight;
    }

    const epoch = state.epoch;
    const fetchStartedAtMs = Date.now();
    // Start the user callback immediately (getToken() should fire the mint
    // request right away), but convert a synchronous throw into a rejection
    // so the in-flight bookkeeping below stays consistent.
    let fetched: Promise<FetchTokenResult>;
    try {
      fetched = Promise.resolve(state.fetchToken());
    } catch (error) {
      fetched = Promise.reject(error);
    }
    const inFlight: Promise<string> = fetched
      .then((result) => {
        const token = validateFetchedToken(result);
        if (state.epoch === epoch) {
          state.token = token;
          state.expiresAtMs = fetchStartedAtMs + result.expiresIn * 1000;
        }
        // If invalidate() ran mid-flight, still hand this (already-minted)
        // token to the callers who asked before the invalidation — but do
        // not cache it; the next getToken() fetches fresh.
        return token;
      })
      .finally(() => {
        if (state.inFlight === inFlight) {
          state.inFlight = null;
        }
      });

    state.inFlight = inFlight;
    return inFlight;
  }

  /**
   * Drop the cached token (and detach any in-flight refresh) so the next
   * `getToken()` fetches a fresh one. Call this when the API answers 401,
   * then retry the request once with a new `getToken()`.
   */
  invalidate(): void {
    const state = getState(this);
    state.token = null;
    state.expiresAtMs = 0;
    state.inFlight = null;
    state.epoch += 1;
  }
}
