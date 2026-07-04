import type { DocumentProcessingResultOutDTO } from './generated';

/**
 * Base class for all hand-written Gemina SDK errors.
 *
 * Transport/HTTP errors raised by the generated client (`ResponseError`,
 * `FetchError`, `RequiredError`) pass through unwrapped — catch those
 * separately if you need HTTP-level detail.
 */
export class GeminaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    // Restore the prototype chain so `instanceof` works after down-leveling.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown by `GeminaClient.processDocument` when processing reaches the
 * terminal `failed` status. `result.errors` carries the failure details.
 */
export class GeminaProcessingError extends GeminaError {
  /** The full terminal processing result (status `failed`). */
  readonly result: DocumentProcessingResultOutDTO;

  constructor(result: DocumentProcessingResultOutDTO, message?: string) {
    super(message ?? 'Document processing failed');
    this.result = result;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown by `GeminaClient.processDocument` when the overall polling deadline
 * (`timeoutSeconds`) is exceeded before a terminal status is reached.
 * Carries the `correlationId` (and the last seen non-terminal result) so
 * callers can resume polling themselves via
 * `client.documents.getDocumentProcessingResultByCorrelationId({ correlationId })`.
 */
export class GeminaTimeoutError extends GeminaError {
  /** Correlation ID of the still-in-flight processing request. */
  readonly correlationId: string;
  /** Last (non-terminal) result seen before the deadline, if any. */
  readonly lastResult?: DocumentProcessingResultOutDTO;

  constructor(
    correlationId: string,
    lastResult?: DocumentProcessingResultOutDTO,
    message?: string,
  ) {
    super(
      message ??
        `Timed out waiting for document processing result (correlationId: ${correlationId})`,
    );
    this.correlationId = correlationId;
    this.lastResult = lastResult;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
