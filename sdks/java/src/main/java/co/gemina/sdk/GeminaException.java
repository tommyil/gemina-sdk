package co.gemina.sdk;

/**
 * Base exception for errors raised by the hand-written Gemina SDK layer
 * (e.g. malformed server responses during polling).
 *
 * <p>Transport/HTTP errors from the generated client pass through unwrapped as
 * {@link co.gemina.sdk.generated.ApiException}.</p>
 */
public class GeminaException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    public GeminaException(String message) {
        super(message);
    }

    public GeminaException(String message, Throwable cause) {
        super(message, cause);
    }
}
