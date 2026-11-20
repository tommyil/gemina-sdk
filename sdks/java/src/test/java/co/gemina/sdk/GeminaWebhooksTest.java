package co.gemina.sdk;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.DoubleSupplier;
import java.util.stream.Stream;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.junit.jupiter.params.provider.ValueSource;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import co.gemina.sdk.generated.model.DocumentProcessingResultOutDTO;
import co.gemina.sdk.generated.model.ExtractionCompletedEventData;
import co.gemina.sdk.generated.model.ExtractionMetaOutDTO;
import co.gemina.sdk.generated.model.WebhookTestEventData;

/**
 * {@link GeminaWebhooks#unwrap} against the shared vectors (contract §6).
 * Mirrors sdks/python/tests/test_webhooks.py case for case.
 *
 * <p>No test here constructs a {@link GeminaClient}: the typed-result case is the
 * proof that the helper installs the lenient date parsing itself. Run this class
 * alone too ({@code -Dtest=GeminaWebhooksTest}), since another class in the same
 * JVM may have constructed a client first.</p>
 */
class GeminaWebhooksTest {

    static final class Vector {
        final String name;
        final String secret;
        final double now;
        /** One entry per JSON property: two names that differ only in case stay two entries. */
        final Map<String, String> headers;
        final String body;
        final String expectType;
        final String reason;

        Vector(JsonObject v) {
            name = v.get("name").getAsString();
            secret = v.get("secret").getAsString();
            now = v.get("now").getAsDouble();
            headers = new LinkedHashMap<>();
            for (Map.Entry<String, JsonElement> h : v.getAsJsonObject("headers").entrySet()) {
                headers.put(h.getKey(), h.getValue().getAsString());
            }
            body = v.get("body").getAsString();
            expectType = v.has("expectType") && !v.get("expectType").isJsonNull() ? v.get("expectType").getAsString() : null;
            reason = v.has("reason") ? v.get("reason").getAsString() : null;
        }

        @Override
        public String toString() {
            return name;
        }
    }

    private static final Map<String, List<Vector>> SHARED = load("webhook_test_vectors.json");
    private static final Map<String, List<Vector>> TYPED = load("webhook_typed_vectors.json");
    private static final String OTHER_SIGNATURE = "v1," + Base64.getEncoder().encodeToString(new byte[32]);

    private static Map<String, List<Vector>> load(String name) {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null && !Files.isDirectory(dir.resolve("testdata"))) {
            dir = dir.getParent();
        }
        if (dir == null) {
            throw new IllegalStateException("no testdata directory above " + Paths.get("").toAbsolutePath());
        }
        try {
            JsonObject file = JsonParser.parseString(
                    new String(Files.readAllBytes(dir.resolve("testdata").resolve(name)), StandardCharsets.UTF_8))
                    .getAsJsonObject();
            Map<String, List<Vector>> out = new LinkedHashMap<>();
            for (String key : new String[] {"valid", "invalid"}) {
                List<Vector> list = new ArrayList<>();
                for (JsonElement v : file.getAsJsonArray(key)) {
                    list.add(new Vector(v.getAsJsonObject()));
                }
                out.put(key, list);
            }
            return out;
        } catch (IOException e) {
            throw new IllegalStateException("cannot read " + name, e);
        }
    }

    static Stream<Vector> validVectors() {
        return Stream.concat(SHARED.get("valid").stream(), TYPED.get("valid").stream());
    }

    static Stream<Vector> invalidVectors() {
        return Stream.concat(SHARED.get("invalid").stream(), TYPED.get("invalid").stream());
    }

    private static Vector named(List<Vector> list, String name) {
        for (Vector v : list) {
            if (v.name.equals(name)) return v;
        }
        throw new IllegalArgumentException("no vector named " + name);
    }

    private static Vector utf8() {
        return named(SHARED.get("valid"), "extraction-completed-utf8-body");
    }

    private static WebhookOptions clock(double now) {
        return new WebhookOptions().now(() -> now);
    }

    private static WebhookEvent unwrap(Vector v) {
        return GeminaWebhooks.unwrap(v.body, v.headers, v.secret, clock(v.now));
    }

    private static WebhookEvent unwrap(Vector v, Map<String, String> headers) {
        return GeminaWebhooks.unwrap(v.body, headers, v.secret, clock(v.now));
    }

    private static String reasonOf(Runnable call) {
        GeminaWebhookVerificationException error = assertThrows(GeminaWebhookVerificationException.class, call::run);
        assertInstanceOf(GeminaException.class, error);
        return error.getReason();
    }

    private static Map<String, String> with(Map<String, String> headers, String name, String value) {
        Map<String, String> copy = new LinkedHashMap<>(headers);
        copy.put(name, value);
        return copy;
    }

    /** The vector's headers, re-signed for other body bytes (for bodies JSON text cannot carry). */
    private static Map<String, String> signed(Vector v, byte[] body) throws Exception {
        Map<String, String> headers = new LinkedHashMap<>();
        for (Map.Entry<String, String> h : v.headers.entrySet()) {
            headers.put(h.getKey().toLowerCase(java.util.Locale.ROOT), h.getValue());
        }
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(Base64.getDecoder().decode(v.secret.substring("whsec_".length())), "HmacSHA256"));
        mac.update((headers.get("webhook-id") + "." + headers.get("webhook-timestamp") + ".").getBytes(StandardCharsets.UTF_8));
        headers.put("webhook-signature", "v1," + Base64.getEncoder().encodeToString(mac.doFinal(body)));
        return headers;
    }

    @Test
    void everyVectorIsLoaded() {
        // A truncated or mis-copied file would otherwise shrink the parameterized cases silently.
        assertEquals(12, SHARED.get("valid").size());
        assertEquals(30, SHARED.get("invalid").size());
        assertEquals(3, TYPED.get("valid").size());
        assertEquals(3, TYPED.get("invalid").size());
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("validVectors")
    void validVectorsVerify(Vector v) {
        WebhookEvent event = unwrap(v);
        assertEquals(v.expectType, event.getType());
        // The id header specifically: "one of the header values" would also pass for the timestamp.
        String id = null;
        for (Map.Entry<String, String> h : v.headers.entrySet()) {
            if (h.getKey().equalsIgnoreCase("webhook-id")) {
                id = h.getValue();
                break;
            }
        }
        assertEquals(id, event.getId());
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("invalidVectors")
    void invalidVectorsAreRejectedWithTheExactReason(Vector v) {
        assertEquals(v.reason, reasonOf(() -> unwrap(v)));
    }

    @Test
    void bytesAndStringBodiesAreEquivalent() {
        Vector v = utf8();
        WebhookEvent asBytes = GeminaWebhooks.unwrap(v.body.getBytes(StandardCharsets.UTF_8), v.headers, v.secret, clock(v.now));
        assertEquals(unwrap(v).getRaw(), asBytes.getRaw());
    }

    @Test
    void allFourOverloadsExist() {
        Vector v = named(SHARED.get("invalid"), "timestamp-too-old"); // so that the default clock and tolerance both matter
        byte[] bytes = v.body.getBytes(StandardCharsets.UTF_8);
        assertEquals("timestamp_out_of_tolerance", reasonOf(() -> GeminaWebhooks.unwrap(v.body, v.headers, v.secret)));
        assertEquals("timestamp_out_of_tolerance", reasonOf(() -> GeminaWebhooks.unwrap(bytes, v.headers, v.secret)));
        WebhookOptions options = clock(v.now).toleranceSeconds(600);
        assertEquals("extraction.completed", GeminaWebhooks.unwrap(v.body, v.headers, v.secret, options).getType());
        assertEquals("extraction.completed", GeminaWebhooks.unwrap(bytes, v.headers, v.secret, options).getType());
    }

    @Test
    void extractionCompletedDataIsTyped() {
        WebhookEvent event = unwrap(utf8());
        assertTrue(event.getData() instanceof ExtractionCompletedEventData);
        ExtractionCompletedEventData data = (ExtractionCompletedEventData) event.getData();
        assertEquals("3f2b6c1e-0d4a-4a57-9a43-1f0e5a7b9c10", data.getCorrelationId().toString());
        assertEquals("חשבונית-2291", data.getExternalId());
        assertEquals(Boolean.FALSE, data.getResultIncluded());
        assertNull(data.getResult());
        assertEquals("2026-11-18T10:15:30Z", event.getTimestamp());
    }

    @Test
    void anIncludedResultIsParsedLikeThePollingPathParsesIt() throws IOException {
        WebhookEvent event = unwrap(named(TYPED.get("valid"), "extraction-completed-with-result"));
        assertTrue(event.getData() instanceof ExtractionCompletedEventData);
        ExtractionCompletedEventData data = (ExtractionCompletedEventData) event.getData();
        assertNull(data.getError());
        // The wire values, which every language asserts the same way:
        JsonObject rawResult = event.getRaw().getAsJsonObject("data").getAsJsonObject("result");
        JsonObject wireMeta = rawResult.getAsJsonObject("data").getAsJsonArray("extractions").get(0)
                .getAsJsonObject().getAsJsonObject("meta");
        assertTrue(wireMeta.get("purgeReason").isJsonNull());
        assertEquals("2026-08-03T17:20:13.180624", wireMeta.get("purgeAt").getAsString());
        // The typed side: exactly what the polling path's parser returns for the same JSON.
        DocumentProcessingResultOutDTO polled = DocumentProcessingResultOutDTO.fromJson(rawResult.toString());
        assertEquals(polled, data.getResult());
        ExtractionMetaOutDTO meta = data.getResult().getData().getExtractions().get(0).getMeta();
        assertNull(meta.getPurgeReason());
        assertEquals(java.time.OffsetDateTime.of(2026, 8, 3, 17, 20, 13, 180_624_000, java.time.ZoneOffset.UTC), meta.getPurgeAt());
        assertEquals("28677df7-033a-409f-8b70-1568ddd17ea0", data.getResult().getMeta().getDocumentId().toString());
    }

    @Test
    void anEnumValueAddedToTheApiLaterReadsAsUnknownLikePolling() throws IOException {
        WebhookEvent event = unwrap(named(TYPED.get("valid"), "extraction-completed-with-unknown-enum-values"));
        DocumentProcessingResultOutDTO result = ((ExtractionCompletedEventData) event.getData()).getResult();
        assertEquals(co.gemina.sdk.generated.model.ResponseStatus.UNKNOWN_DEFAULT_OPEN_API, result.getStatus());
        assertEquals(co.gemina.sdk.generated.model.ModelType.UNKNOWN_DEFAULT_OPEN_API,
                result.getData().getExtractions().get(0).getMeta().getModelType());
        JsonObject raw = event.getRaw().getAsJsonObject("data").getAsJsonObject("result"); // the value sent stays in raw
        assertEquals("queued", raw.get("status").getAsString());
        assertEquals(DocumentProcessingResultOutDTO.fromJson(raw.toString()), result);      // polling reads it the same way
    }

    @ParameterizedTest
    @ValueSource(strings = {"42", "{}", "[]"})
    void onlyAnUnknownStringReadsAsUnknownAnythingElseIsStillRefused(String modelType) throws Exception {
        Vector v = named(TYPED.get("valid"), "extraction-completed-with-unknown-enum-values");
        JsonObject body = JsonParser.parseString(v.body).getAsJsonObject();
        JsonObject result = body.getAsJsonObject("data").getAsJsonObject("result");
        result.getAsJsonObject("data").getAsJsonArray("extractions").get(0).getAsJsonObject()
                .getAsJsonObject("meta").add("modelType", JsonParser.parseString(modelType));
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        Map<String, String> headers = signed(v, bytes);
        assertEquals("invalid_body", reasonOf(() -> GeminaWebhooks.unwrap(bytes, headers, v.secret, clock(v.now))));
        // The polling reader refuses it too.
        assertThrows(Exception.class, () -> DocumentProcessingResultOutDTO.fromJson(result.toString()));
    }

    @Test
    void anErrorEnvelopeIsTyped() {
        ExtractionCompletedEventData data = (ExtractionCompletedEventData)
                unwrap(named(TYPED.get("valid"), "extraction-completed-with-error")).getData();
        assertNull(data.getResult());
        assertEquals("failed", data.getStatus());
        assertEquals("PROCESSING_ERROR", data.getError().getErrors().get(0).get("error_code"));
    }

    @Test
    void theTestEventMessageIsTyped() {
        Object data = unwrap(named(SHARED.get("valid"), "test-event")).getData();
        if (data instanceof WebhookTestEventData) {
            assertEquals("This is a test event from Gemina.", ((WebhookTestEventData) data).getMessage());
        } else {
            fail("expected WebhookTestEventData");
        }
    }

    @Test
    void anUnknownEventTypeKeepsItsTypeAndItsData() {
        WebhookEvent event = unwrap(named(SHARED.get("valid"), "unknown-future-event-type"));
        assertEquals("invoice.archived", event.getType());
        assertEquals(JsonParser.parseString("{\"documentId\":\"9b1d4f0a-6c2e-4d8b-8f31-5a7c0e2b4d66\",\"nested\":{\"n\":1}}"),
                event.getData());
    }

    @Test
    void aBodyWithNoTypeIsReturnedRaw() {
        WebhookEvent event = unwrap(named(SHARED.get("valid"), "standard-webhooks-published-example"));
        assertNull(event.getType());
        assertEquals(JsonParser.parseString("{\"test\":2432232314}"), event.getRaw());
    }

    @Test
    void aCustomToleranceIsHonoured() {
        Vector v = named(SHARED.get("invalid"), "timestamp-too-old");
        assertEquals("extraction.completed",
                GeminaWebhooks.unwrap(v.body, v.headers, v.secret, clock(v.now).toleranceSeconds(600)).getType());
    }

    @Test
    void theCallersBufferIsCopiedBeforeAnythingElseReadsIt() {
        // The clock runs after the copy and before the HMAC: overwriting the array from inside it
        // fails any helper that signs or parses the caller's array.
        Vector v = utf8();
        byte[] buffer = v.body.getBytes(StandardCharsets.UTF_8);
        DoubleSupplier overwrite = () -> {
            java.util.Arrays.fill(buffer, (byte) 'x');
            return v.now;
        };
        WebhookEvent event = GeminaWebhooks.unwrap(buffer, v.headers, v.secret, new WebhookOptions().now(overwrite));
        assertEquals("extraction.completed", event.getType());
    }

    static Stream<Arguments> headerOrders() {
        return Stream.of(Arguments.of("webhook-id", "Webhook-Id"), Arguments.of("Webhook-Id", "webhook-id"));
    }

    @ParameterizedTest
    @MethodSource("headerOrders")
    void aRepeatedHeaderIsJudgedTheSameInEitherOrder(String first, String second) {
        Vector v = utf8();
        String real = v.headers.get("webhook-id");
        Map<String, String> same = new LinkedHashMap<>();
        same.put(first, real);
        same.put(second, real);
        Map<String, String> different = new LinkedHashMap<>();
        different.put(first, real);
        different.put(second, "evt_other");
        for (Map.Entry<String, String> h : v.headers.entrySet()) {
            if (!h.getKey().equals("webhook-id")) {
                same.put(h.getKey(), h.getValue());
                different.put(h.getKey(), h.getValue());
            }
        }
        assertEquals(real, unwrap(v, same).getId());
        assertEquals("ambiguous_header", reasonOf(() -> unwrap(v, different)));
    }

    @Test
    void aRepeatedHeaderThatALibraryAlreadyJoinedIsJudgedTheSame() {
        // A Map cannot hold one name twice, so a repeat reaches the helper joined with ", "
        // (the README sample joins a Spring HttpHeaders that way).
        Vector v = utf8();
        String signature = v.headers.get("webhook-signature");
        assertEquals("extraction.completed",
                unwrap(v, with(v.headers, "webhook-signature", signature + ", " + signature)).getType());
        for (String joined : new String[] {OTHER_SIGNATURE + ", " + signature, signature + ", " + OTHER_SIGNATURE}) {
            assertEquals("ambiguous_header", reasonOf(() -> unwrap(v, with(v.headers, "webhook-signature", joined))));
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"webhoo\u212A-id", "webhook-\u0131d"})
    void headerNamesAreFoldedByAsciiCaseOnly(String lookalike) {
        // KELVIN SIGN lower-cases to "k" and DOTLESS I upper-cases to "I" under Unicode rules,
        // and String.equalsIgnoreCase matches both. Header names are ASCII.
        Vector v = utf8();
        Map<String, String> headers = new LinkedHashMap<>();
        for (Map.Entry<String, String> h : v.headers.entrySet()) {
            headers.put(h.getKey().equals("webhook-id") ? lookalike : h.getKey(), h.getValue());
        }
        assertEquals("missing_header", reasonOf(() -> unwrap(v, headers)));
    }

    static Stream<Arguments> unusableClockOrTolerance() {
        return Stream.of(
                Arguments.of("tolerance -1", -1, Double.NaN),
                Arguments.of("now NaN", 300, Double.NaN),
                Arguments.of("now +Infinity", 300, Double.POSITIVE_INFINITY),
                Arguments.of("now -Infinity", 300, Double.NEGATIVE_INFINITY));
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("unusableClockOrTolerance")
    void aClockOrToleranceThatIsNotUsableNeverSwitchesTheCheckOff(String label, int tolerance, double now) {
        // An expired delivery, correctly signed. NaN makes "difference > tolerance" false: it must not pass.
        Vector v = named(SHARED.get("invalid"), "timestamp-too-old");
        double clockValue = label.startsWith("tolerance") ? v.now : now;
        WebhookOptions options = clock(clockValue).toleranceSeconds(tolerance);
        assertEquals("timestamp_out_of_tolerance",
                reasonOf(() -> GeminaWebhooks.unwrap(v.body, v.headers, v.secret, options)));
    }

    @Test
    void textThatIsNotWellFormedVerifiesTheSubstitutedBytes() {
        // String.getBytes(UTF_8) replaces an unpaired surrogate, so the signature no longer matches.
        Vector v = utf8();
        assertEquals("no_matching_signature",
                reasonOf(() -> GeminaWebhooks.unwrap(v.body + "\ud800", v.headers, v.secret, clock(v.now))));
    }

    @Test
    void aSignedBodyThatIsNotUtf8IsRejected() throws Exception {
        Vector v = utf8();
        byte[] prefix = "{\"type\":\"extraction.completed\",\"data\":\"".getBytes(StandardCharsets.US_ASCII);
        byte[] body = java.util.Arrays.copyOf(prefix, prefix.length + 3);
        body[prefix.length] = (byte) 0xFF;
        body[prefix.length + 1] = '"';
        body[prefix.length + 2] = '}';
        Map<String, String> headers = signed(v, body);
        assertEquals("invalid_body", reasonOf(() -> GeminaWebhooks.unwrap(body, headers, v.secret, clock(v.now))));
    }

    @Test
    void anUnsetSecretIsAnInvalidSecret() {
        // System.getenv returns null when the variable is not set.
        Vector v = utf8();
        assertEquals("invalid_secret", reasonOf(() -> GeminaWebhooks.unwrap(v.body, v.headers, null, clock(v.now))));
    }

    @Test
    void onlyTheVerificationErrorEverLeavesTheHelper() {
        Vector v = utf8();
        List<Map<String, String>> cases = new ArrayList<>();
        cases.add(null);
        cases.add(Collections.<String, String>emptyMap());
        cases.add(Collections.<String, String>singletonMap("webhook-id", null));
        cases.add(Collections.singletonMap("webhook-timestamp", new String(new char[400]).replace('\0', '9')));
        for (Map<String, String> headers : cases) {
            reasonOf(() -> GeminaWebhooks.unwrap(v.body, headers, v.secret));
        }
        reasonOf(() -> GeminaWebhooks.unwrap((String) null, v.headers, v.secret, clock(v.now)));
        reasonOf(() -> GeminaWebhooks.unwrap((byte[]) null, v.headers, v.secret, clock(v.now)));
    }
}
