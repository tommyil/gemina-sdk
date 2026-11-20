"""Verify and parse an incoming Gemina webhook (HELPER_CONTRACT section 6).

Hand-written; lives outside ``gemina.generated``. No network, no GeminaClient.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import re
import time
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Mapping, NoReturn, Optional, Tuple, Union

from .errors import GeminaWebhookVerificationError
from .generated.models.extraction_completed_event_data import ExtractionCompletedEventData
from .generated.models.webhook_test_event_data import WebhookTestEventData

SECRET_PREFIX = "whsec_"
DEFAULT_TOLERANCE_SECONDS = 300
EXTRACTION_COMPLETED = "extraction.completed"
WEBHOOK_TEST = "webhook.test"

# Standard alphabet, padded, no whitespace. The same expression in every SDK.
_BASE64 = re.compile(r"(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?")
_TIMESTAMP = re.compile(r"[0-9]{1,12}")
_BYTE_ORDER_MARK = b"\xef\xbb\xbf"
# Header names are compared ignoring ASCII case only: str.lower() would also fold
# characters such as U+212A KELVIN SIGN to "k".
_ASCII_LOWER = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")
_KNOWN = {
    EXTRACTION_COMPLETED: (ExtractionCompletedEventData,
                           {"correlationId": str, "status": str, "resultIncluded": bool, "resultPath": str}),
    WEBHOOK_TEST: (WebhookTestEventData, {"message": str}),
}


@dataclass(frozen=True)
class WebhookEvent:
    """A verified webhook.

    Attributes:
        id: The ``webhook-id`` header. The same on every retry: deduplicate on it.
        type: ``extraction.completed``, ``webhook.test``, another type added
            later, or ``None`` when the body has no ``type``.
        timestamp: When the event was recorded; the same on every retry.
        data: ``ExtractionCompletedEventData`` or ``WebhookTestEventData`` for
            the known types; the parsed value for any other type.
        raw: The whole parsed body.
    """

    id: str
    type: Optional[str]
    timestamp: Optional[str]
    data: Any
    raw: Any


def _fail(reason: str, message: str) -> NoReturn:
    raise GeminaWebhookVerificationError(reason, message)


def _text(value: Any) -> str:
    # Header bytes (an ASGI scope's, say) are decoded the way aiohttp decodes them, so the
    # signed prefix can be encoded back to the same bytes (see unwrap_webhook).
    return value.decode("utf-8", errors="surrogateescape") if isinstance(value, (bytes, bytearray)) else str(value)


def _entries(headers: Any) -> list:
    """(name, value) entries of a mapping, or of an iterable of pairs; anything else holds none."""
    if hasattr(headers, "items"):
        return list(headers.items())
    try:
        return [entry for entry in headers if isinstance(entry, (list, tuple)) and len(entry) == 2]
    except TypeError:                             # not iterable: no headers at all
        return []


def _header(headers: Any, name: str) -> str:
    values: list = []
    for key, value in _entries(headers):
        if _text(key).translate(_ASCII_LOWER) != name or value is None:
            continue
        for item in (value if isinstance(value, (list, tuple)) else (value,)):
            for part in _text(item).split(", "):    # a repeat that an HTTP library already joined
                if part not in values:
                    values.append(part)
    if not values:
        _fail("missing_header", f"The {name} header is missing.")
    if len(values) > 1:
        _fail("ambiguous_header", f"The {name} header was sent more than once with different values.")
    return values[0]


def _decode_base64(text: str) -> Optional[bytes]:
    if _BASE64.fullmatch(text) is None:
        return None
    return base64.b64decode(text)


def _reject_constant(name: str) -> None:
    raise ValueError(f"{name} is not JSON")


def _as_float(value: Any) -> float:
    """The clock's or the tolerance's value as a float; NaN when it is not a number at all."""
    try:
        return float(value)
    except (TypeError, ValueError, OverflowError):
        return math.nan


def _is_complete(event_type: str, data: Any) -> bool:
    """Step 10: the required fields, and for extraction.completed a whole result or error, never both."""
    required = _KNOWN[event_type][1]
    if not isinstance(data, dict) or any(type(data.get(field)) is not kind for field, kind in required.items()):
        return False
    if event_type != EXTRACTION_COMPLETED:
        return True
    result, error = data.get("result"), data.get("error")
    if result is not None and error is not None:
        return False
    if result is not None and not (isinstance(result, dict) and type(result.get("status")) is str
                                   and isinstance(result.get("meta"), dict) and "data" in result):
        return False
    return error is None or (isinstance(error, dict) and type(error.get("status")) is str)


def unwrap_webhook(
    body: Union[bytes, bytearray, memoryview, str],
    headers: Union[Mapping[str, Any], Iterable[Tuple[Any, Any]]],
    secret: str,
    *,
    tolerance_seconds: float = DEFAULT_TOLERANCE_SECONDS,
    now: Callable[[], float] = time.time,
) -> WebhookEvent:
    """Verify a webhook's signature and timestamp, then parse it.

    Pass the RAW request body exactly as received. A body that was parsed and
    re-serialised will not verify: the signature covers the exact bytes.

    Args:
        body: The request body as bytes, or as text (encoded as UTF-8).
        headers: The request headers, as a mapping or as (name, value) pairs, in
            text or bytes. Names are matched ignoring ASCII case; a value may be a
            list, or several values already joined with ", ".
        secret: The endpoint's signing secret, ``whsec_...``.
        tolerance_seconds: The largest accepted distance between the clock and
            the ``webhook-timestamp`` header. Default 300.
        now: Clock in seconds since the epoch; may return a fraction.

    Raises:
        GeminaWebhookVerificationError: the delivery is not verified or cannot
            be parsed; ``reason`` says why. No other error leaves this function
            for any body, header or secret.
    """
    # No body and no headers are judged like empty ones, as in the other SDKs.
    body = b"" if body is None else body
    headers = {} if headers is None else headers
    # One private copy. bytes() copies a bytearray, so the caller's buffer is never read again.
    try:
        raw_body = body.encode("utf-8") if isinstance(body, str) else bytes(body)
    except UnicodeEncodeError as exc:              # an unpaired surrogate: this text was never a UTF-8 body
        raise GeminaWebhookVerificationError("invalid_body", "The webhook body is not well-formed text.") from exc

    event_id = _header(headers, "webhook-id")
    timestamp_text = _header(headers, "webhook-timestamp")
    signature_header = _header(headers, "webhook-signature")

    if _TIMESTAMP.fullmatch(timestamp_text) is None:
        _fail("invalid_timestamp", "The webhook-timestamp header is not a whole number of seconds.")
    clock, tolerance = _as_float(now()), _as_float(tolerance_seconds)
    if not (math.isfinite(clock) and math.isfinite(tolerance) and tolerance >= 0):
        # NaN compares false with everything: without this, an old delivery would pass.
        _fail("timestamp_out_of_tolerance",
              "The clock or the tolerance is not a finite number, so the timestamp cannot be checked.")
    if abs(math.floor(clock) - int(timestamp_text)) > tolerance:
        _fail("timestamp_out_of_tolerance",
              f"The webhook timestamp is more than {tolerance_seconds} seconds from the current time.")

    key = None
    if isinstance(secret, str):
        key = _decode_base64(secret[len(SECRET_PREFIX):] if secret.startswith(SECRET_PREFIX) else secret)
    if not key:                                    # not set, not base64, or an empty key anyone could sign with
        _fail("invalid_secret", "The signing secret is not valid: expected whsec_ followed by base64.")

    try:
        # A header that was not UTF-8 on the wire arrives surrogate-escaped (aiohttp decodes headers
        # that way): encoding it back the same way signs exactly the bytes that were sent.
        prefix = f"{event_id}.{timestamp_text}.".encode("utf-8", errors="surrogateescape")
    except UnicodeEncodeError as exc:            # a lone surrogate no received bytes decode to
        raise GeminaWebhookVerificationError(
            "no_matching_signature", "The webhook-id header holds text that was never received bytes.") from exc
    expected = hmac.new(key, prefix + raw_body, hashlib.sha256).digest()

    matched = False
    for entry in signature_header.split(" "):
        version, _, signature = entry.partition(",")
        if version != "v1":
            continue
        candidate = _decode_base64(signature)
        if candidate is not None and hmac.compare_digest(candidate, expected):
            matched = True          # no early exit: keep the comparison count independent of position
    if not matched:
        _fail("no_matching_signature", "No signature in the webhook-signature header matches.")

    if raw_body.startswith(_BYTE_ORDER_MARK):
        _fail("invalid_body", "The webhook body starts with a byte order mark.")
    try:
        parsed = json.loads(raw_body.decode("utf-8"), parse_constant=_reject_constant)
    except (ValueError, RecursionError) as exc:   # UnicodeDecodeError and JSONDecodeError are ValueErrors
        raise GeminaWebhookVerificationError("invalid_body", "The webhook body is not valid JSON.") from exc
    if not isinstance(parsed, dict):
        _fail("invalid_body", "The webhook body is not a JSON object.")

    event_type = parsed.get("type") if isinstance(parsed.get("type"), str) else None
    timestamp = parsed.get("timestamp") if isinstance(parsed.get("timestamp"), str) else None
    data = parsed.get("data")
    if event_type in _KNOWN:
        if not _is_complete(event_type, data):
            _fail("invalid_body", f"The data of this {event_type} event is missing a required field.")
        model = _KNOWN[event_type][0]
        try:
            data = model.from_dict(data)
        except Exception as exc:  # noqa: BLE001 - the generated converter documents no error set; the contract allows one type out
            raise GeminaWebhookVerificationError(
                "invalid_body", f"The data of this {event_type} event could not be read.") from exc

    return WebhookEvent(id=event_id, type=event_type, timestamp=timestamp, data=data, raw=parsed)
