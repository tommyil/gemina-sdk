package co.gemina.sdk;

/**
 * Thrown by {@link GeminaWebhooks#unwrap} when an incoming webhook cannot be
 * verified or parsed (contract §6). No other exception type leaves the helper.
 */
public class GeminaWebhookVerificationException extends GeminaException {

    private static final long serialVersionUID = 1L;

    private final String reason;

    public GeminaWebhookVerificationException(String reason, String message) {
        super(message);
        this.reason = reason;
    }

    public GeminaWebhookVerificationException(String reason, String message, Throwable cause) {
        super(message, cause);
        this.reason = reason;
    }

    /**
     * Why the delivery was refused: {@code missing_header}, {@code ambiguous_header},
     * {@code invalid_timestamp}, {@code timestamp_out_of_tolerance}, {@code invalid_secret},
     * {@code no_matching_signature} or {@code invalid_body}.
     */
    public String getReason() {
        return reason;
    }
}
