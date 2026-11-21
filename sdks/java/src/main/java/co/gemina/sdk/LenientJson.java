package co.gemina.sdk;

import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeFormatterBuilder;
import java.time.temporal.ChronoField;

import co.gemina.sdk.generated.JSON;

/**
 * Installs the lenient date-time format into the generated {@link JSON} config,
 * whose adapters are static and global. Used by {@link GeminaClient} and by
 * {@link GeminaWebhooks}, which must parse a webhook's result exactly as polling
 * does without a client instance.
 */
final class LenientJson {

    /**
     * ISO-8601 date-time with an optional offset (the API serves some
     * timestamps, e.g. {@code servedAt}, without one — treated as UTC). Also
     * used for serializing, where it emits the standard offset form.
     */
    private static final DateTimeFormatter LENIENT_OFFSET_DATE_TIME = new DateTimeFormatterBuilder()
            .append(DateTimeFormatter.ISO_LOCAL_DATE_TIME)
            .optionalStart()
            .appendOffsetId()
            .optionalEnd()
            .parseDefaulting(ChronoField.OFFSET_SECONDS, 0)
            .toFormatter();

    static {
        // The JVM runs this once, on the first call to install(), whichever caller comes first.
        JSON.setOffsetDateTimeFormat(LENIENT_OFFSET_DATE_TIME);
    }

    private LenientJson() {
    }

    /** Makes sure the lenient format is installed; the static initializer above does the work. */
    static void install() {
    }
}
