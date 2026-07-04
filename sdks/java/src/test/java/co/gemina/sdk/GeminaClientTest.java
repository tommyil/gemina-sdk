package co.gemina.sdk;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.io.File;
import java.net.URI;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Random;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import co.gemina.sdk.generated.ApiException;
import co.gemina.sdk.generated.api.DocumentApi;
import co.gemina.sdk.generated.model.DocumentProcessingMetaOutDTO;
import co.gemina.sdk.generated.model.DocumentProcessingResultOutDTO;
import co.gemina.sdk.generated.model.ExtractionTypeModel;
import co.gemina.sdk.generated.model.ResponseStatus;
import co.gemina.sdk.generated.model.WebDocumentUploadInDTO;

/**
 * Contract §3 unit tests — mocked at the generated-API boundary, no network,
 * no real waiting (recording no-op {@link Sleeper}).
 */
class GeminaClientTest {

    private static final List<ExtractionTypeModel> TYPES =
            Collections.singletonList(ExtractionTypeModel.INVOICE_HEADERS);

    private GeminaClient client;
    private DocumentApi documentApi;
    private RecordingSleeper sleeper;

    /** Records requested waits without sleeping. */
    private static final class RecordingSleeper implements Sleeper {
        final List<Long> sleeps = new ArrayList<>();

        @Override
        public void sleep(long millis) {
            sleeps.add(millis);
        }
    }

    /** Random whose nextDouble() is fixed at 0.5 -> jitter factor exactly 1.0. */
    private static final class MidpointRandom extends Random {
        @Override
        public double nextDouble() {
            return 0.5;
        }
    }

    private static DocumentProcessingResultOutDTO result(ResponseStatus status, UUID correlationId) {
        return new DocumentProcessingResultOutDTO()
                .status(status)
                .meta(new DocumentProcessingMetaOutDTO().correlationId(correlationId));
    }

    private ProcessDocumentOptions.Builder options() {
        return ProcessDocumentOptions.builder()
                .sleeper(sleeper)
                .random(new MidpointRandom());
    }

    @BeforeEach
    void setUp() {
        client = new GeminaClient("test-api-key", "http://localhost:1");
        documentApi = mock(DocumentApi.class);
        client.setDocumentsApi(documentApi);
        sleeper = new RecordingSleeper();
    }

    @Test
    void happyPath_twoNonTerminalPollsThenSuccess() throws Exception {
        UUID correlationId = UUID.randomUUID();
        File file = new File("invoice.png");
        DocumentProcessingResultOutDTO success = result(ResponseStatus.SUCCESS, correlationId);

        when(documentApi.createDocumentProcessingRequest(
                anyString(), anyList(), any(File.class), isNull(), isNull(), isNull(),
                isNull(), isNull(), isNull(), isNull()))
                .thenReturn(result(ResponseStatus.PENDING, correlationId));
        when(documentApi.getDocumentProcessingResultByCorrelationId(correlationId))
                .thenReturn(result(ResponseStatus.PENDING, correlationId))
                .thenReturn(result(ResponseStatus.IN_PROCESS, correlationId))
                .thenReturn(success);

        DocumentProcessingResultOutDTO returned = client.processDocument(
                GeminaDocumentSource.fromFile(file), TYPES, options().build());

        assertSame(success, returned);
        assertEquals(ResponseStatus.SUCCESS, returned.getStatus());
        verify(documentApi, times(3)).getDocumentProcessingResultByCorrelationId(correlationId);
        verify(documentApi).createDocumentProcessingRequest(
                anyString(), eq(TYPES), eq(file), isNull(), isNull(), isNull(),
                isNull(), isNull(), isNull(), isNull());
        assertEquals(3, sleeper.sleeps.size());
    }

    @Test
    void terminalOnSubmit_returnsWithoutPolling() throws Exception {
        DocumentProcessingResultOutDTO partial = result(ResponseStatus.PARTIAL, UUID.randomUUID());
        when(documentApi.createDocumentProcessingRequest(
                anyString(), anyList(), any(File.class), isNull(), isNull(), isNull(),
                isNull(), isNull(), isNull(), isNull()))
                .thenReturn(partial);

        DocumentProcessingResultOutDTO returned = client.processDocument(
                GeminaDocumentSource.fromFile(new File("invoice.png")), TYPES, options().build());

        assertSame(partial, returned);
        verify(documentApi, never()).getDocumentProcessingResultByCorrelationId(any());
        assertTrue(sleeper.sleeps.isEmpty());
    }

    @Test
    void failedStatus_throwsProcessingExceptionCarryingResult() throws Exception {
        UUID correlationId = UUID.randomUUID();
        DocumentProcessingResultOutDTO failed = result(ResponseStatus.FAILED, correlationId)
                .errors(Collections.singletonList(
                        Collections.singletonMap("message", (Object) "could not read document")));

        when(documentApi.createDocumentProcessingRequest(
                anyString(), anyList(), any(File.class), isNull(), isNull(), isNull(),
                isNull(), isNull(), isNull(), isNull()))
                .thenReturn(result(ResponseStatus.PENDING, correlationId));
        when(documentApi.getDocumentProcessingResultByCorrelationId(correlationId))
                .thenReturn(failed);

        GeminaProcessingException exception = assertThrows(GeminaProcessingException.class,
                () -> client.processDocument(
                        GeminaDocumentSource.fromFile(new File("invoice.png")), TYPES, options().build()));

        assertSame(failed, exception.getResult());
        assertEquals(1, exception.getResult().getErrors().size());
    }

    @Test
    void timeout_throwsTimeoutExceptionWithCorrelationIdAndLastResult() throws Exception {
        UUID correlationId = UUID.randomUUID();
        DocumentProcessingResultOutDTO pending = result(ResponseStatus.PENDING, correlationId);

        when(documentApi.createDocumentProcessingRequest(
                anyString(), anyList(), any(File.class), isNull(), isNull(), isNull(),
                isNull(), isNull(), isNull(), isNull()))
                .thenReturn(pending);
        when(documentApi.getDocumentProcessingResultByCorrelationId(correlationId))
                .thenReturn(pending); // never terminal

        // Jitter fixed at 1.0 -> waits 2000, 3000; virtual elapsed hits 5000ms >= 4.9s.
        GeminaTimeoutException exception = assertThrows(GeminaTimeoutException.class,
                () -> client.processDocument(
                        GeminaDocumentSource.fromFile(new File("invoice.png")), TYPES,
                        options().timeoutSeconds(4.9).build()));

        assertEquals(correlationId, exception.getCorrelationId());
        assertNotNull(exception.getLastResult());
        assertEquals(ResponseStatus.PENDING, exception.getLastResult().getStatus());
        assertEquals(Arrays.asList(2000L, 3000L), sleeper.sleeps);
    }

    @Test
    void backoffSchedule_growsByOnePointFiveCappedAt15sExactWithoutJitter() throws Exception {
        UUID correlationId = UUID.randomUUID();

        when(documentApi.createDocumentProcessingRequest(
                anyString(), anyList(), any(File.class), isNull(), isNull(), isNull(),
                isNull(), isNull(), isNull(), isNull()))
                .thenReturn(result(ResponseStatus.PENDING, correlationId));
        when(documentApi.getDocumentProcessingResultByCorrelationId(correlationId))
                .thenReturn(result(ResponseStatus.PENDING, correlationId))
                .thenReturn(result(ResponseStatus.PENDING, correlationId))
                .thenReturn(result(ResponseStatus.PENDING, correlationId))
                .thenReturn(result(ResponseStatus.PENDING, correlationId))
                .thenReturn(result(ResponseStatus.PENDING, correlationId))
                .thenReturn(result(ResponseStatus.PENDING, correlationId))
                .thenReturn(result(ResponseStatus.SUCCESS, correlationId));

        client.processDocument(
                GeminaDocumentSource.fromFile(new File("invoice.png")), TYPES,
                options().timeoutSeconds(3600).build());

        // Nominal schedule with jitter factor pinned to 1.0: x1.5 growth, capped at 15000.
        assertEquals(
                Arrays.asList(2000L, 3000L, 4500L, 6750L, 10125L, 15000L, 15000L),
                sleeper.sleeps);
    }

    @Test
    void backoffSchedule_jitterStaysWithinBoundsWithSeededRandom() throws Exception {
        UUID correlationId = UUID.randomUUID();

        when(documentApi.createDocumentProcessingRequest(
                anyString(), anyList(), any(File.class), isNull(), isNull(), isNull(),
                isNull(), isNull(), isNull(), isNull()))
                .thenReturn(result(ResponseStatus.PENDING, correlationId));
        when(documentApi.getDocumentProcessingResultByCorrelationId(correlationId))
                .thenReturn(result(ResponseStatus.PENDING, correlationId))
                .thenReturn(result(ResponseStatus.PENDING, correlationId))
                .thenReturn(result(ResponseStatus.PENDING, correlationId))
                .thenReturn(result(ResponseStatus.PENDING, correlationId))
                .thenReturn(result(ResponseStatus.PENDING, correlationId))
                .thenReturn(result(ResponseStatus.PENDING, correlationId))
                .thenReturn(result(ResponseStatus.SUCCESS, correlationId));

        client.processDocument(
                GeminaDocumentSource.fromFile(new File("invoice.png")), TYPES,
                options().random(new Random(1234L)).timeoutSeconds(3600).build());

        long[] nominal = {2000L, 3000L, 4500L, 6750L, 10125L, 15000L, 15000L};
        assertEquals(nominal.length, sleeper.sleeps.size());
        for (int i = 0; i < nominal.length; i++) {
            long actual = sleeper.sleeps.get(i);
            long low = Math.round(nominal[i] * 0.8);
            long high = Math.round(nominal[i] * 1.2);
            assertTrue(actual >= low && actual <= high,
                    "sleep[" + i + "]=" + actual + " outside jitter bounds [" + low + ", " + high + "]");
        }
    }

    @Test
    void urlSource_routesToWebEndpointWithSubmissionOptions() throws Exception {
        UUID correlationId = UUID.randomUUID();
        when(documentApi.createWebDocumentProcessingRequest(any(WebDocumentUploadInDTO.class)))
                .thenReturn(result(ResponseStatus.PENDING, correlationId));
        when(documentApi.getDocumentProcessingResultByCorrelationId(correlationId))
                .thenReturn(result(ResponseStatus.SUCCESS, correlationId));

        DocumentProcessingResultOutDTO returned = client.processDocument(
                GeminaDocumentSource.fromUrl("https://example.com/invoice.pdf"), TYPES,
                options().externalId("invoice-42").endUserId("end-user-7").build());

        assertEquals(ResponseStatus.SUCCESS, returned.getStatus());
        ArgumentCaptor<WebDocumentUploadInDTO> captor =
                ArgumentCaptor.forClass(WebDocumentUploadInDTO.class);
        verify(documentApi).createWebDocumentProcessingRequest(captor.capture());
        WebDocumentUploadInDTO body = captor.getValue();
        assertEquals(URI.create("https://example.com/invoice.pdf"), body.getUrl());
        assertEquals("invoice-42", body.getExternalId());
        assertEquals(TYPES, body.getExtractionTypes());
        assertEquals("end-user-7", body.getEndUserId());
        verify(documentApi, never()).createDocumentProcessingRequest(
                anyString(), anyList(), any(File.class), any(), any(), any(),
                any(), any(), any(), any());
    }

    @Test
    void nonTerminalSubmitWithoutCorrelationId_throwsGeminaException() throws Exception {
        DocumentProcessingResultOutDTO malformed = new DocumentProcessingResultOutDTO()
                .status(ResponseStatus.PENDING)
                .meta(new DocumentProcessingMetaOutDTO()); // no correlationId

        when(documentApi.createDocumentProcessingRequest(
                anyString(), anyList(), any(File.class), isNull(), isNull(), isNull(),
                isNull(), isNull(), isNull(), isNull()))
                .thenReturn(malformed);

        assertThrows(GeminaException.class,
                () -> client.processDocument(
                        GeminaDocumentSource.fromFile(new File("invoice.png")), TYPES, options().build()));
        verify(documentApi, never()).getDocumentProcessingResultByCorrelationId(any());
    }

    /** HTTP 500 whose body IS a failed DocumentProcessingResultOutDTO (API behavior for terminal failures). */
    private static String failedResultJson(UUID correlationId) {
        return "{\"data\":null,"
                + "\"errors\":[{\"message\":\"processing blew up\"}],"
                + "\"meta\":{\"correlationId\":\"" + correlationId + "\"},"
                + "\"status\":\"failed\"}";
    }

    private static ApiException http500(String body) {
        return new ApiException("Internal Server Error", 500,
                Collections.<String, List<String>>emptyMap(), body);
    }

    @Test
    void failedResultServedAs500OnPoll_throwsProcessingExceptionWithParsedResult() throws Exception {
        UUID correlationId = UUID.randomUUID();

        when(documentApi.createDocumentProcessingRequest(
                anyString(), anyList(), any(File.class), isNull(), isNull(), isNull(),
                isNull(), isNull(), isNull(), isNull()))
                .thenReturn(result(ResponseStatus.PENDING, correlationId));
        when(documentApi.getDocumentProcessingResultByCorrelationId(correlationId))
                .thenThrow(http500(failedResultJson(correlationId)));

        GeminaProcessingException exception = assertThrows(GeminaProcessingException.class,
                () -> client.processDocument(
                        GeminaDocumentSource.fromFile(new File("invoice.png")), TYPES, options().build()));

        assertEquals(ResponseStatus.FAILED, exception.getResult().getStatus());
        assertEquals(correlationId, exception.getResult().getMeta().getCorrelationId());
        assertEquals(1, exception.getResult().getErrors().size());
        assertEquals("processing blew up", exception.getResult().getErrors().get(0).get("message"));
        // A failed-result body is terminal — never treated as transient, no retry.
        verify(documentApi, times(1)).getDocumentProcessingResultByCorrelationId(correlationId);
    }

    @Test
    void transientPollErrorsThenSuccess_retriesOnSameBackoffSchedule() throws Exception {
        UUID correlationId = UUID.randomUUID();
        DocumentProcessingResultOutDTO success = result(ResponseStatus.SUCCESS, correlationId);

        when(documentApi.createDocumentProcessingRequest(
                anyString(), anyList(), any(File.class), isNull(), isNull(), isNull(),
                isNull(), isNull(), isNull(), isNull()))
                .thenReturn(result(ResponseStatus.PENDING, correlationId));
        when(documentApi.getDocumentProcessingResultByCorrelationId(correlationId))
                .thenThrow(http500("upstream connect error"))
                .thenThrow(http500("upstream connect error"))
                .thenReturn(success);

        DocumentProcessingResultOutDTO returned = client.processDocument(
                GeminaDocumentSource.fromFile(new File("invoice.png")), TYPES, options().build());

        assertSame(success, returned);
        verify(documentApi, times(3)).getDocumentProcessingResultByCorrelationId(correlationId);
        // Backoff keeps growing x1.5 across the failed attempts (jitter pinned to 1.0).
        assertEquals(Arrays.asList(2000L, 3000L, 4500L), sleeper.sleeps);
    }

    @Test
    void threeConsecutiveTransientPollErrors_rethrowsLastErrorUnchanged() throws Exception {
        UUID correlationId = UUID.randomUUID();
        ApiException first = http500("blip 1");
        ApiException second = http500("blip 2");
        ApiException third = http500("blip 3");

        when(documentApi.createDocumentProcessingRequest(
                anyString(), anyList(), any(File.class), isNull(), isNull(), isNull(),
                isNull(), isNull(), isNull(), isNull()))
                .thenReturn(result(ResponseStatus.PENDING, correlationId));
        when(documentApi.getDocumentProcessingResultByCorrelationId(correlationId))
                .thenThrow(first)
                .thenThrow(second)
                .thenThrow(third);

        ApiException thrown = assertThrows(ApiException.class,
                () -> client.processDocument(
                        GeminaDocumentSource.fromFile(new File("invoice.png")), TYPES, options().build()));

        assertSame(third, thrown);
        verify(documentApi, times(3)).getDocumentProcessingResultByCorrelationId(correlationId);
    }

    @Test
    void transientPollFailureCounter_resetsAfterSuccessfulPoll() throws Exception {
        UUID correlationId = UUID.randomUUID();
        DocumentProcessingResultOutDTO success = result(ResponseStatus.SUCCESS, correlationId);

        when(documentApi.createDocumentProcessingRequest(
                anyString(), anyList(), any(File.class), isNull(), isNull(), isNull(),
                isNull(), isNull(), isNull(), isNull()))
                .thenReturn(result(ResponseStatus.PENDING, correlationId));
        // 2 failures, a successful (non-terminal) poll resets the counter,
        // then 2 more failures — never 3 consecutive — then success.
        when(documentApi.getDocumentProcessingResultByCorrelationId(correlationId))
                .thenThrow(http500("blip 1"))
                .thenThrow(http500("blip 2"))
                .thenReturn(result(ResponseStatus.IN_PROCESS, correlationId))
                .thenThrow(http500("blip 3"))
                .thenThrow(http500("blip 4"))
                .thenReturn(success);

        DocumentProcessingResultOutDTO returned = client.processDocument(
                GeminaDocumentSource.fromFile(new File("invoice.png")), TYPES, options().build());

        assertSame(success, returned);
        verify(documentApi, times(6)).getDocumentProcessingResultByCorrelationId(correlationId);
        assertEquals(Arrays.asList(2000L, 3000L, 4500L, 6750L, 10125L, 15000L), sleeper.sleeps);
    }

    @Test
    void failedResultServedAs500OnSubmit_throwsProcessingExceptionWithParsedResult() throws Exception {
        UUID correlationId = UUID.randomUUID();

        when(documentApi.createDocumentProcessingRequest(
                anyString(), anyList(), any(File.class), isNull(), isNull(), isNull(),
                isNull(), isNull(), isNull(), isNull()))
                .thenThrow(http500(failedResultJson(correlationId)));

        GeminaProcessingException exception = assertThrows(GeminaProcessingException.class,
                () -> client.processDocument(
                        GeminaDocumentSource.fromFile(new File("invoice.png")), TYPES, options().build()));

        assertEquals(ResponseStatus.FAILED, exception.getResult().getStatus());
        verify(documentApi, never()).getDocumentProcessingResultByCorrelationId(any());
    }

    @Test
    void plainHttp500OnPoll_rethrowsOriginalApiExceptionUnchanged() throws Exception {
        UUID correlationId = UUID.randomUUID();
        ApiException plainError = http500("{\"detail\":\"upstream blew up\"}");

        when(documentApi.createDocumentProcessingRequest(
                anyString(), anyList(), any(File.class), isNull(), isNull(), isNull(),
                isNull(), isNull(), isNull(), isNull()))
                .thenReturn(result(ResponseStatus.PENDING, correlationId));
        when(documentApi.getDocumentProcessingResultByCorrelationId(correlationId))
                .thenThrow(plainError);

        ApiException thrown = assertThrows(ApiException.class,
                () -> client.processDocument(
                        GeminaDocumentSource.fromFile(new File("invoice.png")), TYPES, options().build()));

        assertSame(plainError, thrown);
    }

    @Test
    void errorBodyParseableButNotFailed_rethrowsOriginalApiException() throws Exception {
        UUID correlationId = UUID.randomUUID();
        // Parseable as a result DTO but NOT status=failed -> must pass through unchanged.
        ApiException oddError = http500("{\"data\":null,\"meta\":{\"correlationId\":\""
                + correlationId + "\"},\"status\":\"pending\"}");

        when(documentApi.createDocumentProcessingRequest(
                anyString(), anyList(), any(File.class), isNull(), isNull(), isNull(),
                isNull(), isNull(), isNull(), isNull()))
                .thenReturn(result(ResponseStatus.PENDING, correlationId));
        when(documentApi.getDocumentProcessingResultByCorrelationId(correlationId))
                .thenThrow(oddError);

        ApiException thrown = assertThrows(ApiException.class,
                () -> client.processDocument(
                        GeminaDocumentSource.fromFile(new File("invoice.png")), TYPES, options().build()));

        assertSame(oddError, thrown);
    }

    @Test
    void emptyExtractionTypes_rejected() {
        assertThrows(IllegalArgumentException.class,
                () -> client.processDocument(
                        GeminaDocumentSource.fromFile(new File("invoice.png")),
                        Collections.<ExtractionTypeModel>emptyList(), options().build()));
    }

    @Test
    void fileSubmit_generatesExternalIdWhenUnset() throws Exception {
        UUID correlationId = UUID.randomUUID();
        when(documentApi.createDocumentProcessingRequest(
                anyString(), anyList(), any(File.class), isNull(), isNull(), isNull(),
                isNull(), isNull(), isNull(), isNull()))
                .thenReturn(result(ResponseStatus.SUCCESS, correlationId));

        client.processDocument(GeminaDocumentSource.fromFile(new File("invoice.png")), TYPES,
                options().build());

        ArgumentCaptor<String> externalId = ArgumentCaptor.forClass(String.class);
        verify(documentApi).createDocumentProcessingRequest(
                externalId.capture(), anyList(), any(File.class), isNull(), isNull(), isNull(),
                isNull(), isNull(), isNull(), isNull());
        // Auto-generated external id is a UUID string (parseable, 36 chars).
        assertEquals(36, externalId.getValue().length());
        UUID.fromString(externalId.getValue());
    }
}
