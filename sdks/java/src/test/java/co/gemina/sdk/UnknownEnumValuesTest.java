package co.gemina.sdk;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import co.gemina.sdk.generated.model.WebhookEndpointOutDTO;
import co.gemina.sdk.generated.model.WebhookEventOutDTO;

/**
 * A nullable enum reads a value the API added later as UNKNOWN_DEFAULT_OPEN_API, as every
 * other enum does, and a JSON null as null (contract section 6).
 */
class UnknownEnumValuesTest {

    @BeforeAll
    static void lenientDates() {
        GeminaClient.installLenientJson();
    }

    private static String event(String failureReason) {
        return "{\"id\":\"8a1d0c55-2f8e-4c1b-9d6e-5b2f1a3c4d5e\",\"endpointId\":\"5f2b7c1e-2b6b-4f0e-9a1c-3d4e5f6a7b8c\","
                + "\"webhookId\":\"evt_0123456789abcdef0123456789abcdef\",\"type\":\"extraction.completed\",\"status\":\"failed\","
                + "\"failureReason\":" + failureReason + ",\"attemptCount\":2,\"manual\":false,\"occurredAt\":\"2026-11-18T10:15:30Z\"}";
    }

    private static String endpoint(String disabledReason) {
        return "{\"id\":\"5f2b7c1e-2b6b-4f0e-9a1c-3d4e5f6a7b8c\",\"url\":\"https://example.com/gemina/webhook\",\"enabled\":false,"
                + "\"disabledReason\":" + disabledReason + ",\"notBefore\":\"2026-11-18T10:15:30Z\"}";
    }

    @Test
    void anUnknownFailureReasonIsUnknownNotAbsent() throws Exception {
        assertEquals(WebhookEventOutDTO.FailureReasonEnum.UNKNOWN_DEFAULT_OPEN_API,
                WebhookEventOutDTO.FailureReasonEnum.fromValue("rate_limited"));
        assertEquals(WebhookEventOutDTO.FailureReasonEnum.UNKNOWN_DEFAULT_OPEN_API,
                WebhookEventOutDTO.fromJson(event("\"rate_limited\"")).getFailureReason());
        assertNull(WebhookEventOutDTO.fromJson(event("null")).getFailureReason());
    }

    @Test
    void anUnknownDisabledReasonIsUnknownNotAbsent() throws Exception {
        assertEquals(WebhookEndpointOutDTO.DisabledReasonEnum.UNKNOWN_DEFAULT_OPEN_API,
                WebhookEndpointOutDTO.DisabledReasonEnum.fromValue("suspended"));
        assertEquals(WebhookEndpointOutDTO.DisabledReasonEnum.UNKNOWN_DEFAULT_OPEN_API,
                WebhookEndpointOutDTO.fromJson(endpoint("\"suspended\"")).getDisabledReason());
        assertNull(WebhookEndpointOutDTO.fromJson(endpoint("null")).getDisabledReason());
    }
}
