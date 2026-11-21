package co.gemina.sdk;

/** The values of {@link GeminaWebhookVerificationException#getReason()} (contract §6). */
public final class GeminaWebhookVerificationReason {

    /** A webhook-id, webhook-timestamp or webhook-signature header is missing. */
    public static final String MISSING_HEADER = "missing_header";

    /** A webhook-id, webhook-timestamp or webhook-signature header was sent more than once with different values. */
    public static final String AMBIGUOUS_HEADER = "ambiguous_header";

    /** The webhook-timestamp header is not 1 to 12 ASCII digits. */
    public static final String INVALID_TIMESTAMP = "invalid_timestamp";

    /** The timestamp is too far from the clock, or the clock or the tolerance is not usable. */
    public static final String TIMESTAMP_OUT_OF_TOLERANCE = "timestamp_out_of_tolerance";

    /** The signing secret is not whsec_ followed by base64 of at least one byte. */
    public static final String INVALID_SECRET = "invalid_secret";

    /** No v1 signature in the webhook-signature header matches the body. */
    public static final String NO_MATCHING_SIGNATURE = "no_matching_signature";

    /** The body is not one JSON object, or a known event's data is incomplete or cannot be read. */
    public static final String INVALID_BODY = "invalid_body";

    private GeminaWebhookVerificationReason() {
    }
}
