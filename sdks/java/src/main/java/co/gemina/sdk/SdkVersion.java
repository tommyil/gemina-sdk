package co.gemina.sdk;

/**
 * The SDK package version. This is the single hand-written source of truth for
 * the version consumed by the {@code User-Agent} string
 * ({@code gemina-sdk-java/<version>}); the generated client's own metadata
 * version is irrelevant and discarded.
 */
public final class SdkVersion {

    /** The gemina-sdk package version. Keep in sync with {@code pom.xml}. */
    public static final String VERSION = "0.2.1";

    private SdkVersion() {
    }
}
