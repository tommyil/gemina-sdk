package co.gemina.sdk.smoke;

import co.gemina.sdk.GeminaClient;
import co.gemina.sdk.generated.model.RetrievalStatusOutDTO;

/**
 * Live smoke check — NOT part of the published jar (test scope only).
 *
 * <p>Reads {@code GEMINA_BASE_URL} (optional, defaults to production) and
 * {@code GEMINA_API_KEY} (required), calls {@code GET /v1/retrieval/status}
 * and prints the result. Exits 1 on any failure.</p>
 *
 * <pre>
 * GEMINA_BASE_URL=https://api.staging.gemina.co GEMINA_API_KEY=... \
 *   mvn -Psmoke -DskipTests test-compile exec:java
 * </pre>
 */
public final class Smoke {

    private Smoke() {
    }

    public static void main(String[] args) {
        String baseUrl = System.getenv("GEMINA_BASE_URL");
        String apiKey = System.getenv("GEMINA_API_KEY");
        if (apiKey == null || apiKey.isEmpty()) {
            System.err.println("Smoke FAILED: GEMINA_API_KEY environment variable is not set");
            System.exit(1);
        }
        try {
            GeminaClient client = (baseUrl == null || baseUrl.isEmpty())
                    ? new GeminaClient(apiKey)
                    : new GeminaClient(apiKey, baseUrl);
            RetrievalStatusOutDTO status = client.retrieval().retrievalStatus();
            System.out.println("Smoke OK: retrievalStatus() -> indexedDocuments="
                    + status.getIndexedDocuments() + ", servedAt=" + status.getServedAt());
        } catch (Exception e) {
            System.err.println("Smoke FAILED: " + e);
            e.printStackTrace();
            System.exit(1);
        }
    }
}
