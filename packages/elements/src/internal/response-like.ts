/**
 * Shared transport-error helpers for the widgets (chat + verification).
 *
 * Extracted verbatim from chat.tsx so both components read thrown SDK errors
 * the same way. Pure and dependency-free: no React, no DOM.
 */

/**
 * The response-like object carried by a thrown transport error. We pull it off
 * by shape rather than `instanceof ResponseError` — robust against duplicated
 * `@gemina/sdk` copies in a bundle (class identity is not shared across
 * copies). On the fetch transport this is the raw `Response`, so `status`,
 * `headers`, and the JSON body are all reachable from here.
 */
export interface ResponseLike {
  status?: number;
  headers?: { get?: (name: string) => string | null };
  json?: () => Promise<unknown>;
  clone?: () => ResponseLike;
}

export function getResponseLike(error: unknown): ResponseLike | undefined {
  if (error !== null && typeof error === 'object' && 'response' in error) {
    const response = (error as { response?: unknown }).response;
    if (response !== null && typeof response === 'object') {
      return response as ResponseLike;
    }
  }
  return undefined;
}

/** Extract an HTTP status from a thrown value, or `undefined`. */
export function httpStatus(error: unknown): number | undefined {
  const status = getResponseLike(error)?.status;
  return typeof status === 'number' ? status : undefined;
}

/** What the standard backend error envelope reliably carries. */
export interface ErrorEnvelope {
  status: number | undefined;
  /** Stable backend `errors[0].error_code`. */
  errorCode: string | undefined;
  /** Human-readable server fallback (`errors[0].description`). */
  description: string | undefined;
}

/**
 * Read what the backend actually sent on an error. Only the HTTP status and
 * the stable `errors[0].error_code` / `description` are reliable across
 * environments — production strips `errors[0].detail`, so we never touch it.
 * The fetch body can be read once, so we clone defensively; if that fails
 * (non-JSON, empty, or already consumed) the status still stands.
 */
export async function readErrorEnvelope(error: unknown): Promise<ErrorEnvelope> {
  const response = getResponseLike(error);
  const info: ErrorEnvelope = {
    status: typeof response?.status === 'number' ? response.status : undefined,
    errorCode: undefined,
    description: undefined,
  };
  if (response === undefined) {
    return info;
  }

  let body: unknown;
  try {
    const source = typeof response.clone === 'function' ? response.clone() : response;
    body = typeof source.json === 'function' ? await source.json() : undefined;
  } catch {
    body = undefined;
  }
  if (body !== null && typeof body === 'object') {
    const errors = (body as { errors?: unknown }).errors;
    if (
      Array.isArray(errors) &&
      errors.length > 0 &&
      errors[0] !== null &&
      typeof errors[0] === 'object'
    ) {
      const first = errors[0] as { error_code?: unknown; description?: unknown };
      if (typeof first.error_code === 'string') {
        info.errorCode = first.error_code;
      }
      if (typeof first.description === 'string') {
        info.description = first.description;
      }
    }
  }
  return info;
}
