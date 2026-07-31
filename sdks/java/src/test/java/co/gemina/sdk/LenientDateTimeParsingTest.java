package co.gemina.sdk;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import co.gemina.sdk.generated.JSON;
import co.gemina.sdk.generated.model.FoundationDTO;
import co.gemina.sdk.generated.model.RetrievalStatusOutDTO;

/**
 * The API serves timestamps without a timezone designator (e.g.
 * {@code "servedAt":"2026-07-31T11:16:09.501109"}) even though the schema
 * declares RFC 3339 {@code date-time}. The generated adapter's default
 * {@code ISO_OFFSET_DATE_TIME} rejects that form, so the hand-written facade
 * installs {@code LENIENT_OFFSET_DATE_TIME} into the (static, global)
 * {@link JSON} config. These tests pin that end to end: without the lenient
 * formatter every call against the live API fails with
 * {@code DateTimeParseException}.
 */
class LenientDateTimeParsingTest {

    /** Verbatim shape of a live {@code GET /v1/retrieval/status} 200 body. */
    private static final String NAIVE_BODY = "{"
            + "\"servedAt\":\"2026-07-31T11:16:09.501109\","
            + "\"servedAtTimestamp\":1785496569.5,"
            + "\"createdAt\":null,\"createdAtTimestamp\":null,"
            + "\"indexedDocuments\":42}";

    private static final OffsetDateTime SERVED_AT_UTC =
            OffsetDateTime.of(2026, 7, 31, 11, 16, 9, 501_109_000, ZoneOffset.UTC);

    @BeforeAll
    static void installFormatterViaFacade() {
        // Any facade construction path must be enough to make parsing work.
        new GeminaClient("test-key");
    }

    @Test
    void parsesNaiveTimestampsAsUtc() {
        RetrievalStatusOutDTO dto =
                JSON.getGson().fromJson(NAIVE_BODY, RetrievalStatusOutDTO.class);
        assertEquals(SERVED_AT_UTC, dto.getServedAt());
        assertEquals(42, dto.getIndexedDocuments());
    }

    @Test
    void parsesExplicitUtcDesignator() {
        // Future-proofing: if the API ever emits RFC 3339 offsets, nothing breaks.
        String body = NAIVE_BODY.replace("501109\"", "501109Z\"");
        RetrievalStatusOutDTO dto =
                JSON.getGson().fromJson(body, RetrievalStatusOutDTO.class);
        assertEquals(SERVED_AT_UTC, dto.getServedAt());
    }

    @Test
    void parsesExplicitNonUtcOffsetToSameInstant() {
        String body = NAIVE_BODY.replace("T11:16:09.501109\"", "T14:16:09.501109+03:00\"");
        RetrievalStatusOutDTO dto =
                JSON.getGson().fromJson(body, RetrievalStatusOutDTO.class);
        assertTrue(SERVED_AT_UTC.isEqual(dto.getServedAt()),
                "expected same instant, got " + dto.getServedAt());
    }

    @Test
    void parsesLiveErrorEnvelope() {
        // Verbatim body of an unauthenticated production call (2026-07-31):
        // the error path serves the same naive servedAt as success bodies.
        String body = "{"
                + "\"servedAt\":\"2026-07-31T11:21:58.881759\","
                + "\"servedAtTimestamp\":1785496918.8817644,"
                + "\"createdAt\":null,\"createdAtTimestamp\":null,"
                + "\"status\":\"failed\",\"meta\":null,\"data\":null,"
                + "\"errors\":[{\"error_code\":\"UNAUTHORIZED_ERROR\","
                + "\"description\":\"API Key Unauthorized: Missing API Key\"}]}";
        FoundationDTO dto = JSON.getGson().fromJson(body, FoundationDTO.class);
        assertEquals(ZoneOffset.UTC, dto.getServedAt().getOffset());
        assertEquals("UNAUTHORIZED_ERROR", dto.getErrors().get(0).get("error_code"));
    }

    @Test
    void serializesWithExplicitOffset() {
        RetrievalStatusOutDTO dto =
                JSON.getGson().fromJson(NAIVE_BODY, RetrievalStatusOutDTO.class);
        String out = JSON.getGson().toJson(dto);
        assertTrue(out.contains("\"servedAt\":\"2026-07-31T11:16:09.501109Z\""),
                "serialized form should carry an explicit offset: " + out);
    }
}
