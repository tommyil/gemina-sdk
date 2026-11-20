#!/usr/bin/env python3
"""Build testdata/webhook_typed_vectors.json: signed webhook bodies that carry a
full result or an error, for the typed-parse tests of every SDK.

Deterministic. `--check` fails if the committed file differs from what this
script builds. The secret is the public test secret of the shared vectors.
"""
import base64
import hashlib
import hmac
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "testdata" / "webhook_typed_vectors.json"

SECRET = "whsec_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
EVENT_ID = "evt_0123456789abcdef0123456789abcdef"
TIMESTAMP = 1795000530
CORRELATION = "3f2b6c1e-0d4a-4a57-9a43-1f0e5a7b9c10"
DOCUMENT = "28677df7-033a-409f-8b70-1568ddd17ea0"

RESULT = {
    "status": "success",
    "meta": {"correlationId": CORRELATION, "documentId": DOCUMENT},
    "data": {"extractions": [{
        "status": "success",
        "meta": {"extractionType": "invoice_headers", "modelType": "velox", "thinking": False,
                 "correction": False, "evaluation": False, "includeCoordinates": True,
                 "processorClass": "InvoiceHeaderAnalysisProcessor",
                 "purgeAt": "2026-08-03T17:20:13.180624", "purgedAt": None, "purgeReason": None},
        "values": {"totalAmount": {"value": 1572.0, "coordinates": None, "confidence": None}},
        "errors": [],
    }]},
    "errors": [],
}
# A result from a newer API: an enum value this SDK does not know, at two depths.
UNKNOWN_ENUMS = {
    **RESULT,
    "status": "queued",
    "data": {"extractions": [{
        **RESULT["data"]["extractions"][0],
        "meta": {**RESULT["data"]["extractions"][0]["meta"], "modelType": "nova"},
    }]},
}
ERROR = {
    "status": "failed",
    "meta": None,
    "data": None,
    "errors": [{"error_code": "PROCESSING_ERROR",
                "description": "Document processing failed: unreadable document"}],
}


def data(**overrides):
    base = {"correlationId": CORRELATION, "documentId": DOCUMENT, "externalId": "חשבונית-2291",
            "endUserId": None, "channel": "public_api", "status": "success", "resultIncluded": True,
            "resultPath": f"/api/v1/documents/results/{CORRELATION}", "result": None, "error": None}
    return {**base, **overrides}


def vector(name, event_data, reason=None):
    body = json.dumps({"type": "extraction.completed", "timestamp": "2026-11-18T10:15:30Z", "data": event_data},
                      ensure_ascii=False, separators=(",", ":"))
    key = base64.b64decode(SECRET[len("whsec_"):])
    digest = hmac.new(key, f"{EVENT_ID}.{TIMESTAMP}.".encode() + body.encode("utf-8"), hashlib.sha256).digest()
    expectation = {"reason": reason} if reason else {"expectType": "extraction.completed"}
    return {"name": name, "secret": SECRET, "now": TIMESTAMP,
            "headers": {"webhook-id": EVENT_ID, "webhook-timestamp": str(TIMESTAMP),
                        "webhook-signature": "v1," + base64.b64encode(digest).decode()},
            "body": body, **expectation}


def build() -> str:
    document = {
        "description": "Signed webhook bodies with a full result or an error. SDK repo only; "
                       "built by tools/build_webhook_typed_vectors.py.",
        "valid": [
            vector("extraction-completed-with-result", data(result=RESULT)),
            vector("extraction-completed-with-error", data(documentId=None, status="failed", error=ERROR)),
            # The typed parse is tolerant, as polling is: values added to an enum later must not fail it.
            vector("extraction-completed-with-unknown-enum-values", data(result=UNKNOWN_ENUMS)),
        ],
        # Correctly signed, and still refused: a known event is never returned half typed.
        "invalid": [
            vector("result-is-an-empty-object", data(result={}), reason="invalid_body"),
            vector("result-and-error-both-set", data(result=RESULT, error=ERROR), reason="invalid_body"),
            vector("error-without-a-status", data(status="failed", error={"errors": []}), reason="invalid_body"),
        ],
    }
    return json.dumps(document, ensure_ascii=False, indent=2) + "\n"


if __name__ == "__main__":
    if "--check" in sys.argv:
        sys.exit(0 if OUT.read_text(encoding="utf-8") == build() else "testdata/webhook_typed_vectors.json is stale")
    OUT.write_text(build(), encoding="utf-8")
