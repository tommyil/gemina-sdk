"""unwrap_webhook against the shared vectors (HELPER_CONTRACT section 6).

This list is the reference: the TypeScript, C#, Java and PHP suites mirror it
case for case.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import pathlib

import pytest

from gemina import (
    DocumentProcessingResultOutDTO,
    GeminaError,
    GeminaWebhookVerificationError,
    WebhookEvent,
    unwrap_webhook,
)

TESTDATA = pathlib.Path(__file__).resolve().parents[3] / "testdata"
VECTORS = json.loads((TESTDATA / "webhook_test_vectors.json").read_text(encoding="utf-8"))
TYPED = json.loads((TESTDATA / "webhook_typed_vectors.json").read_text(encoding="utf-8"))


def unwrap(vector, **kwargs):
    kwargs.setdefault("now", lambda: vector["now"])
    return unwrap_webhook(vector["body"], vector["headers"], vector["secret"], **kwargs)


def named(collection, name):
    return next(v for v in collection if v["name"] == name)


def signed(vector, body: bytes):
    """The vector's headers, re-signed for other body bytes (for bodies JSON text cannot carry)."""
    headers = {k.lower(): v for k, v in vector["headers"].items()}
    key = base64.b64decode(vector["secret"][len("whsec_"):])
    message = f"{headers['webhook-id']}.{headers['webhook-timestamp']}.".encode() + body
    return {**headers, "webhook-signature": "v1," + base64.b64encode(hmac.new(key, message, hashlib.sha256).digest()).decode()}


def test_every_vector_is_loaded():
    # A truncated or mis-copied file would otherwise shrink the parametrised cases silently.
    assert (len(VECTORS["valid"]), len(VECTORS["invalid"])) == (12, 30)
    assert (len(TYPED["valid"]), len(TYPED["invalid"])) == (2, 3)


@pytest.mark.parametrize("vector", VECTORS["valid"] + TYPED["valid"], ids=lambda v: v["name"])
def test_valid_vectors_verify(vector):
    event = unwrap(vector)
    assert isinstance(event, WebhookEvent)
    assert event.type == vector["expectType"]
    # The id header specifically: "one of the header values" would also pass for the timestamp.
    assert event.id == next(v for k, v in vector["headers"].items() if k.lower() == "webhook-id")


@pytest.mark.parametrize("vector", VECTORS["invalid"] + TYPED["invalid"], ids=lambda v: v["name"])
def test_invalid_vectors_are_rejected_with_the_exact_reason(vector):
    with pytest.raises(GeminaWebhookVerificationError) as error:
        unwrap(vector)
    assert error.value.reason == vector["reason"]
    assert isinstance(error.value, GeminaError)


def test_bytes_and_str_bodies_are_equivalent():
    vector = named(VECTORS["valid"], "extraction-completed-utf8-body")
    as_bytes = unwrap_webhook(vector["body"].encode("utf-8"), vector["headers"], vector["secret"], now=lambda: vector["now"])
    assert as_bytes.raw == unwrap(vector).raw


def test_extraction_completed_data_is_typed():
    event = unwrap(named(VECTORS["valid"], "extraction-completed-utf8-body"))
    assert str(event.data.correlation_id) == "3f2b6c1e-0d4a-4a57-9a43-1f0e5a7b9c10"
    assert event.data.external_id == "חשבונית-2291"
    assert event.data.result_included is False and event.data.result is None
    assert event.timestamp == json.loads(named(VECTORS["valid"], "extraction-completed-utf8-body")["body"])["timestamp"]


def test_an_included_result_is_parsed_like_the_polling_path_parses_it():
    event = unwrap(named(TYPED["valid"], "extraction-completed-with-result"))
    result = event.data.result
    assert event.data.error is None
    assert str(result.meta.document_id) == "28677df7-033a-409f-8b70-1568ddd17ea0"
    extraction_meta = result.data.extractions[0].meta
    assert extraction_meta.purge_reason is None                 # a null where the model has an enum
    assert extraction_meta.purge_at.year == 2026 and extraction_meta.purge_at.microsecond == 180624   # a date with no offset
    # The wire values, which every language asserts the same way:
    wire_meta = event.raw["data"]["result"]["data"]["extractions"][0]["meta"]
    assert wire_meta["purgeReason"] is None and wire_meta["purgeAt"] == "2026-08-03T17:20:13.180624"
    # And the typed result is exactly what the polling path's parser gives for the same JSON.
    assert result == DocumentProcessingResultOutDTO.from_json(json.dumps(event.raw["data"]["result"]))


def test_an_error_envelope_is_typed():
    event = unwrap(named(TYPED["valid"], "extraction-completed-with-error"))
    assert event.data.result is None and event.data.status == "failed"
    assert event.data.error.errors[0]["error_code"] == "PROCESSING_ERROR"


def test_the_test_event_message_is_typed():
    event = unwrap(named(VECTORS["valid"], "test-event"))
    assert event.data.message == "This is a test event from Gemina."


def test_an_unknown_event_type_keeps_its_type_and_its_data():
    event = unwrap(named(VECTORS["valid"], "unknown-future-event-type"))
    assert event.type == "invoice.archived"
    assert event.data == {"documentId": "9b1d4f0a-6c2e-4d8b-8f31-5a7c0e2b4d66", "nested": {"n": 1}}


def test_a_body_with_no_type_is_returned_raw():
    event = unwrap(named(VECTORS["valid"], "standard-webhooks-published-example"))
    assert event.type is None and event.raw == {"test": 2432232314}


def test_a_custom_tolerance_is_honoured():
    event = unwrap(named(VECTORS["invalid"], "timestamp-too-old"), tolerance_seconds=600)
    assert event.type == "extraction.completed"


def test_the_callers_buffer_is_copied_before_anything_else_reads_it():
    # Overwriting the buffer AFTER the call returns proves nothing: the parsed event no longer
    # depends on it. The clock runs after the copy (step 1) and before the HMAC (step 6), so
    # overwriting from inside the clock fails any helper that signs or parses the caller's buffer.
    vector = named(VECTORS["valid"], "extraction-completed-utf8-body")
    buffer = bytearray(vector["body"].encode("utf-8"))

    def clock_that_overwrites_the_buffer():
        buffer[:] = b"x" * len(buffer)
        return vector["now"]

    event = unwrap_webhook(buffer, vector["headers"], vector["secret"], now=clock_that_overwrites_the_buffer)
    assert event.raw["type"] == "extraction.completed"


@pytest.mark.parametrize("names", [("webhook-id", "Webhook-Id"), ("Webhook-Id", "webhook-id")])
def test_a_repeated_header_is_judged_the_same_in_either_order(names):
    vector = named(VECTORS["valid"], "extraction-completed-utf8-body")
    real = vector["headers"]["webhook-id"]
    rest = {k: v for k, v in vector["headers"].items() if k != "webhook-id"}
    assert unwrap({**vector, "headers": {names[0]: real, names[1]: real, **rest}}).id == real
    with pytest.raises(GeminaWebhookVerificationError) as error:
        unwrap({**vector, "headers": {names[0]: real, names[1]: "evt_other", **rest}})
    assert error.value.reason == "ambiguous_header"


def test_a_repeated_header_that_a_library_already_joined_is_judged_the_same():
    vector = named(VECTORS["valid"], "extraction-completed-utf8-body")
    signature = vector["headers"]["webhook-signature"]
    other = "v1," + base64.b64encode(b"\x00" * 32).decode()
    assert unwrap({**vector, "headers": {**vector["headers"], "webhook-signature": f"{signature}, {signature}"}}).type
    for joined in (f"{other}, {signature}", f"{signature}, {other}"):      # a valid signature in either place
        with pytest.raises(GeminaWebhookVerificationError) as error:
            unwrap({**vector, "headers": {**vector["headers"], "webhook-signature": joined}})
        assert error.value.reason == "ambiguous_header"


def test_a_header_given_as_a_list_contributes_each_item():
    vector = named(VECTORS["valid"], "extraction-completed-utf8-body")
    signature = vector["headers"]["webhook-signature"]
    other = "v1," + base64.b64encode(b"\x00" * 32).decode()
    assert unwrap({**vector, "headers": {**vector["headers"], "webhook-signature": [signature, signature]}}).type
    with pytest.raises(GeminaWebhookVerificationError) as error:
        unwrap({**vector, "headers": {**vector["headers"], "webhook-signature": [signature, other]}})
    assert error.value.reason == "ambiguous_header"


@pytest.mark.parametrize("lookalike", ["webhoo\u212a-id", "webhook-\u0131d"])
def test_header_names_are_folded_by_ascii_case_only(lookalike):
    # U+212A KELVIN SIGN lower-cases to "k" and U+0131 DOTLESS I upper-cases to "I" under
    # Unicode rules. Header names are ASCII: a name that only matches after a Unicode fold
    # is not the webhook-id header.
    vector = named(VECTORS["valid"], "extraction-completed-utf8-body")
    rest = {k: v for k, v in vector["headers"].items() if k != "webhook-id"}
    with pytest.raises(GeminaWebhookVerificationError) as error:
        unwrap({**vector, "headers": {lookalike: vector["headers"]["webhook-id"], **rest}})
    assert error.value.reason == "missing_header"


@pytest.mark.parametrize("options", [
    {"tolerance_seconds": float("nan")}, {"tolerance_seconds": float("inf")}, {"tolerance_seconds": -1},
    {"now": lambda: float("nan")}, {"now": lambda: float("inf")}, {"now": lambda: float("-inf")},
])
def test_a_clock_or_tolerance_that_is_not_finite_never_switches_the_check_off(options):
    # An expired delivery, correctly signed. NaN makes "difference > tolerance" false: it must not pass.
    with pytest.raises(GeminaWebhookVerificationError) as error:
        unwrap(named(VECTORS["invalid"], "timestamp-too-old"), **options)
    assert error.value.reason == "timestamp_out_of_tolerance"


def test_text_that_is_not_well_formed_never_leaks_a_native_error():
    vector = named(VECTORS["valid"], "extraction-completed-utf8-body")
    with pytest.raises(GeminaWebhookVerificationError) as error:
        unwrap_webhook(vector["body"] + "\ud800", vector["headers"], vector["secret"], now=lambda: vector["now"])
    assert error.value.reason == "invalid_body"     # Python's encoder raises; the other languages substitute


def test_a_signed_body_that_is_not_utf8_is_rejected():
    vector = named(VECTORS["valid"], "extraction-completed-utf8-body")
    body = b'{"type":"extraction.completed","data":"\xff"}'      # JSON text cannot carry this byte, so it is signed here
    with pytest.raises(GeminaWebhookVerificationError) as error:
        unwrap_webhook(body, signed(vector, body), vector["secret"], now=lambda: vector["now"])
    assert error.value.reason == "invalid_body"


def test_an_unset_secret_is_an_invalid_secret():
    # os.environ.get("GEMINA_WEBHOOK_SECRET") gives None when the variable is not set.
    vector = named(VECTORS["valid"], "extraction-completed-utf8-body")
    with pytest.raises(GeminaWebhookVerificationError) as error:
        unwrap_webhook(vector["body"], vector["headers"], None, now=lambda: vector["now"])  # type: ignore[arg-type]
    assert error.value.reason == "invalid_secret"


def test_only_the_verification_error_ever_leaves_the_helper():
    vector = named(VECTORS["valid"], "extraction-completed-utf8-body")
    for headers in ({}, {"webhook-id": None}, {"webhook-timestamp": "9" * 400}):
        with pytest.raises(GeminaWebhookVerificationError):
            unwrap_webhook(vector["body"], headers, vector["secret"])
    # No body and no headers at all, as the C# and Java suites also pass.
    with pytest.raises(GeminaWebhookVerificationError):
        unwrap_webhook(vector["body"], None, vector["secret"])  # type: ignore[arg-type]
    with pytest.raises(GeminaWebhookVerificationError):
        unwrap_webhook(None, vector["headers"], vector["secret"], now=lambda: vector["now"])  # type: ignore[arg-type]
