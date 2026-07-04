/**
 * GeminaTokenManager — the PRD §6.11.1 footgun suite.
 *
 * Offline: no network, no real timers.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminaTokenManager } from '../src/token-manager';

/** Synthetic 32-alphanumeric Gemina-API-key-shaped string (NOT a real key). */
const API_KEY_SHAPED = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';

/** A syntactically JWT-shaped session token (three dot-separated segments). */
function jwt(n: number): string {
  return `eyJhbGciOiJIUzI1NiJ9.payload${n}.signature${n}`;
}

function makeFetchToken(expiresIn = 900): {
  fetchToken: ReturnType<typeof vi.fn>;
  calls: () => number;
} {
  let n = 0;
  const fetchToken = vi.fn(async () => ({ token: jwt(++n), expiresIn }));
  return { fetchToken, calls: () => fetchToken.mock.calls.length };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('GeminaTokenManager — never persists (§6.11.1 footgun 2)', () => {
  it('never writes to localStorage or sessionStorage across a full lifecycle', async () => {
    const localSetItem = vi.spyOn(window.localStorage, 'setItem');
    const sessionSetItem = vi.spyOn(window.sessionStorage, 'setItem');

    const { fetchToken } = makeFetchToken();
    const manager = new GeminaTokenManager({ fetchToken });
    await manager.getToken();
    manager.invalidate();
    await manager.getToken();

    expect(localSetItem).not.toHaveBeenCalled();
    expect(sessionSetItem).not.toHaveBeenCalled();
  });

  it('package source contains no persistence API usage at all', () => {
    // Belt-and-braces: beyond the runtime spies, assert the shipped source
    // never USES a persistence API (word mentions in security comments are
    // fine; property access / calls are not).
    // NOTE: import.meta.url is an http: URL under happy-dom; resolve from
    // the package root (vitest's cwd) instead.
    const srcDir = join(process.cwd(), 'src');
    for (const file of readdirSync(srcDir)) {
      const source = readFileSync(join(srcDir, file), 'utf8');
      expect(source, `${file} must not touch persistent storage`).not.toMatch(
        /(?:localStorage|sessionStorage|indexedDB)\s*[.[(]|document\.cookie|openDatabase\s*\(/,
      );
    }
  });

  it('does not expose the token as an own property of the instance', async () => {
    const { fetchToken } = makeFetchToken();
    const manager = new GeminaTokenManager({ fetchToken });
    const token = await manager.getToken();

    expect(JSON.stringify(manager)).not.toContain(token);
    const ownValues = Object.getOwnPropertyNames(manager).map(
      (name) => (manager as unknown as Record<string, unknown>)[name],
    );
    expect(ownValues).not.toContain(token);
  });
});

describe('GeminaTokenManager — fetch & refresh timing', () => {
  it('fetches lazily on first use and reuses the cached token', async () => {
    const { fetchToken, calls } = makeFetchToken();
    const manager = new GeminaTokenManager({ fetchToken });
    expect(calls()).toBe(0); // constructor does NOT fetch (and starts no timers)

    const first = await manager.getToken();
    const second = await manager.getToken();
    expect(first).toBe(jwt(1));
    expect(second).toBe(first);
    expect(calls()).toBe(1);
  });

  it('reuses the token before expiry−skew and refetches after (default skew 60s)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const { fetchToken, calls } = makeFetchToken(900);
    const manager = new GeminaTokenManager({ fetchToken });

    const first = await manager.getToken();
    expect(calls()).toBe(1);

    // 1ms before the refresh point (expiry 900s − skew 60s = 840s): cached.
    vi.setSystemTime(840_000 - 1);
    await expect(manager.getToken()).resolves.toBe(first);
    expect(calls()).toBe(1);

    // At the refresh point: refetch.
    vi.setSystemTime(840_000);
    const refreshed = await manager.getToken();
    expect(refreshed).toBe(jwt(2));
    expect(calls()).toBe(2);
  });

  it('honors a custom refreshSkewSeconds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const { fetchToken, calls } = makeFetchToken(900);
    const manager = new GeminaTokenManager({ fetchToken, refreshSkewSeconds: 300 });

    await manager.getToken();
    vi.setSystemTime(600_000 - 1);
    await manager.getToken();
    expect(calls()).toBe(1);

    vi.setSystemTime(600_000);
    await manager.getToken();
    expect(calls()).toBe(2);
  });

  it('computes expiry from Date.now() at fetch time + expiresIn', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);

    const { fetchToken, calls } = makeFetchToken(600);
    const manager = new GeminaTokenManager({ fetchToken });
    await manager.getToken();

    // expiry = 1_000_000 + 600_000; refresh point = expiry − 60_000.
    vi.setSystemTime(1_000_000 + 540_000 - 1);
    await manager.getToken();
    expect(calls()).toBe(1);
    vi.setSystemTime(1_000_000 + 540_000);
    await manager.getToken();
    expect(calls()).toBe(2);
  });

  it('does not cache a failed fetch — the next getToken() retries', async () => {
    let attempt = 0;
    const fetchToken = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error('tenant backend unavailable');
      }
      return { token: jwt(attempt), expiresIn: 900 };
    });
    const manager = new GeminaTokenManager({ fetchToken });

    await expect(manager.getToken()).rejects.toThrow('tenant backend unavailable');
    await expect(manager.getToken()).resolves.toBe(jwt(2));
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });

  it('surfaces a synchronously-throwing fetchToken as a rejection', async () => {
    const manager = new GeminaTokenManager({
      fetchToken: () => {
        throw new Error('sync boom');
      },
    });
    await expect(manager.getToken()).rejects.toThrow('sync boom');
  });
});

describe('GeminaTokenManager — single-flight refresh (no stampede)', () => {
  it('concurrent getToken() calls share ONE in-flight fetch', async () => {
    let resolveFetch: ((value: { token: string; expiresIn: number }) => void) | undefined;
    const fetchToken = vi.fn(
      () =>
        new Promise<{ token: string; expiresIn: number }>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const manager = new GeminaTokenManager({ fetchToken });

    const p1 = manager.getToken();
    const p2 = manager.getToken();
    const p3 = manager.getToken();
    expect(fetchToken).toHaveBeenCalledTimes(1);

    resolveFetch?.({ token: jwt(1), expiresIn: 900 });
    await expect(Promise.all([p1, p2, p3])).resolves.toEqual([jwt(1), jwt(1), jwt(1)]);
    expect(fetchToken).toHaveBeenCalledTimes(1);

    // And the shared result is cached for subsequent calls.
    await expect(manager.getToken()).resolves.toBe(jwt(1));
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });
});

describe('GeminaTokenManager — invalidate()', () => {
  it('drops the cached token so the next getToken() refetches', async () => {
    const { fetchToken, calls } = makeFetchToken();
    const manager = new GeminaTokenManager({ fetchToken });

    await expect(manager.getToken()).resolves.toBe(jwt(1));
    manager.invalidate();
    await expect(manager.getToken()).resolves.toBe(jwt(2));
    expect(calls()).toBe(2);
  });

  it('a refresh in flight when invalidate() runs does not repopulate the cache', async () => {
    let resolveFirst: ((value: { token: string; expiresIn: number }) => void) | undefined;
    let call = 0;
    const fetchToken = vi.fn(() => {
      call += 1;
      if (call === 1) {
        return new Promise<{ token: string; expiresIn: number }>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve({ token: jwt(call), expiresIn: 900 });
    });
    const manager = new GeminaTokenManager({ fetchToken });

    const stale = manager.getToken(); // fetch #1, in flight
    manager.invalidate();

    const fresh = manager.getToken(); // must start fetch #2, not join #1
    expect(fetchToken).toHaveBeenCalledTimes(2);

    resolveFirst?.({ token: jwt(1), expiresIn: 900 });
    // Pre-invalidation callers still get the token they asked for...
    await expect(stale).resolves.toBe(jwt(1));
    // ...but the cache holds the post-invalidation token.
    await expect(fresh).resolves.toBe(jwt(2));
    await expect(manager.getToken()).resolves.toBe(jwt(2));
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });
});

describe('GeminaTokenManager — API-key & token-shape guards (§6.11.1 footgun 1)', () => {
  it('THROWS when the constructor is handed a raw API-key-shaped string', () => {
    expect(
      () => new GeminaTokenManager(API_KEY_SHAPED as unknown as { fetchToken: never }),
    ).toThrow(/API key.*never enter the browser/i);
  });

  it('THROWS when the constructor is handed any raw string', () => {
    expect(
      () => new GeminaTokenManager('some-token' as unknown as { fetchToken: never }),
    ).toThrow(/fetchToken/);
  });

  it('THROWS when fetchToken is a string instead of a callback', () => {
    expect(
      () =>
        new GeminaTokenManager({ fetchToken: API_KEY_SHAPED as unknown as () => never }),
    ).toThrow(/API key.*never enter the browser/i);
  });

  it('THROWS when fetchToken is missing or not a function', () => {
    expect(() => new GeminaTokenManager({} as { fetchToken: never })).toThrow(/fetchToken/);
    expect(
      () => new GeminaTokenManager(undefined as unknown as { fetchToken: never }),
    ).toThrow(/options/);
  });

  it('REJECTS when fetchToken resolves with an API-key-shaped token', async () => {
    const manager = new GeminaTokenManager({
      fetchToken: async () => ({ token: API_KEY_SHAPED, expiresIn: 900 }),
    });
    await expect(manager.getToken()).rejects.toThrow(/API key.*never enter the browser/i);
  });

  it('REJECTS non-JWT-shaped tokens (must be three dot-separated segments)', async () => {
    for (const bad of [
      'opaqueTokenWithoutAnyDots1234567890xyz', // 0 dots (and not API-key length)
      'header.payload', // 1 dot
      'a.b.c.d', // 3 dots
      'a..c', // empty segment
    ]) {
      const manager = new GeminaTokenManager({
        fetchToken: async () => ({ token: bad, expiresIn: 900 }),
      });
      await expect(manager.getToken(), `token ${JSON.stringify(bad)}`).rejects.toThrow(
        /JWT|dot-separated/i,
      );
    }
  });

  it('REJECTS an invalid expiresIn', async () => {
    for (const bad of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      const manager = new GeminaTokenManager({
        fetchToken: async () => ({ token: jwt(1), expiresIn: bad }),
      });
      await expect(manager.getToken(), `expiresIn ${bad}`).rejects.toThrow(/expiresIn/);
    }
  });

  it('a rejected validation is not cached — a later good mint recovers', async () => {
    let call = 0;
    const fetchToken = vi.fn(async () => {
      call += 1;
      return call === 1 ? { token: API_KEY_SHAPED, expiresIn: 900 } : { token: jwt(2), expiresIn: 900 };
    });
    const manager = new GeminaTokenManager({ fetchToken });

    await expect(manager.getToken()).rejects.toThrow(/API key/i);
    await expect(manager.getToken()).resolves.toBe(jwt(2));
  });

  it('rejects invalid refreshSkewSeconds at construction', () => {
    const fetchToken = async () => ({ token: jwt(1), expiresIn: 900 });
    expect(() => new GeminaTokenManager({ fetchToken, refreshSkewSeconds: -1 })).toThrow(
      /refreshSkewSeconds/,
    );
    expect(
      () => new GeminaTokenManager({ fetchToken, refreshSkewSeconds: Number.NaN }),
    ).toThrow(/refreshSkewSeconds/);
  });
});
