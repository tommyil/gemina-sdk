package co.gemina.sdk;

import co.gemina.sdk.generated.model.DocumentProcessingResultOutDTO;

/**
 * Thrown by {@link GeminaClient#processDocument} when the document reaches the
 * terminal {@code failed} status. The full result is attached — its
 * {@code errors} list has the details.
 */
public class GeminaProcessingException extends GeminaException {

    private static final long serialVersionUID = 1L;

    private final transient DocumentProcessingResultOutDTO result;

    public GeminaProcessingException(DocumentProcessingResultOutDTO result) {
        super(buildMessage(result));
        this.result = result;
    }

    /** The full terminal {@code failed} result, including its {@code errors} list. */
    public DocumentProcessingResultOutDTO getResult() {
        return result;
    }

    private static String buildMessage(DocumentProcessingResultOutDTO result) {
        int errorCount = result != null && result.getErrors() != null ? result.getErrors().size() : 0;
        return "Document processing failed (" + errorCount
                + " error(s) reported — see getResult().getErrors() for details)";
    }
}
