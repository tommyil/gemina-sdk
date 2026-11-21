package co.gemina.sdk;

import java.util.function.DoubleSupplier;

/** Options for {@link GeminaWebhooks#unwrap}: the timestamp tolerance and the clock. */
public final class WebhookOptions {

    private static final DoubleSupplier SYSTEM_CLOCK = () -> System.currentTimeMillis() / 1000.0;

    // An int, not a double: a double tolerance can hold NaN, which makes both age
    // comparisons false and would let an old, correctly signed delivery verify.
    private int toleranceSeconds = 300;
    private DoubleSupplier now = SYSTEM_CLOCK;

    /** Maximum distance in seconds between the clock and the webhook timestamp. Default 300. */
    public WebhookOptions toleranceSeconds(int toleranceSeconds) {
        this.toleranceSeconds = toleranceSeconds;
        return this;
    }

    /** Clock in seconds since the epoch; may return a fraction. Injectable for tests. Null restores the system clock. */
    public WebhookOptions now(DoubleSupplier now) {
        this.now = now == null ? SYSTEM_CLOCK : now;
        return this;
    }

    public int getToleranceSeconds() {
        return toleranceSeconds;
    }

    public DoubleSupplier getNow() {
        return now;
    }
}
