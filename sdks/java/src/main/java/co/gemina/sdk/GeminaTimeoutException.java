package co.gemina.sdk;

import java.util.UUID;

import co.gemina.sdk.generated.model.DocumentProcessingResultOutDTO;

/**
 * Thrown by {@link GeminaClient#processDocument} when the overall polling
 * deadline ({@code timeoutSeconds}) is exceeded before the document reaches a
 * terminal status. Carries the {@code correlationId} and the last seen result
 * so callers may resume polling themselves via
 * {@code client.documents().getDocumentProcessingResultByCorrelationId(correlationId)}.
 */
public class GeminaTimeoutException extends GeminaException {

    private static final long serialVersionUID = 1L;

    private final UUID correlationId;
    private final transient DocumentProcessingResultOutDTO lastResult;

    public GeminaTimeoutException(UUID correlationId, DocumentProcessingResultOutDTO lastResult) {
        super("Timed out waiting for document processing to complete (correlationId=" + correlationId
                + "); poll GET /v1/documents/results/{correlationId} to resume");
        this.correlationId = correlationId;
        this.lastResult = lastResult;
    }

    /** Correlation id of the in-flight processing request — use it to resume polling. */
    public UUID getCorrelationId() {
        return correlationId;
    }

    /** The last (non-terminal) result seen before the deadline, or {@code null}. */
    public DocumentProcessingResultOutDTO getLastResult() {
        return lastResult;
    }
}
