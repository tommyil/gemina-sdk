"""Live smoke test: hit GET /v1/retrieval/status with the real client.

Usage:
    GEMINA_BASE_URL=https://api.gemina.co GEMINA_API_KEY=... python smoke/smoke.py

Exits non-zero on any failure.
"""

import asyncio
import os
import sys
from pathlib import Path

from gemina import GeminaClient, ModelType, UploadExtractionTypeEnum, __version__


async def main() -> int:
    api_key = os.environ.get("GEMINA_API_KEY")
    base_url = os.environ.get("GEMINA_BASE_URL", "https://api.gemina.co")
    if not api_key:
        print("FAIL: GEMINA_API_KEY environment variable is not set", file=sys.stderr)
        return 2

    print(f"gemina-sdk-python/{__version__} -> {base_url}")
    try:
        async with GeminaClient(api_key, base_url=base_url) as client:
            status = await client.retrieval.retrieval_status()
            history = await client.chat.list_chat_sessions(limit=2)
    except Exception as exc:  # noqa: BLE001 - smoke test reports anything
        print(f"FAIL: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    print(f"typed result: {status!r}")
    print(f"indexedDocuments={status.indexed_documents}")
    if status.indexed_documents is None:
        print("FAIL: indexedDocuments missing from response", file=sys.stderr)
        return 1
    print(f"chatHistory count={history.count} sessions={len(history.sessions)}")
    if not isinstance(history.count, int):
        print("FAIL: chat history count missing from response", file=sys.stderr)
        return 1

    # Add-on round trip is opt-in: it UPLOADS a document and spends credits, so
    # it must never run against production by accident. Enable it explicitly
    # against a staging key that has credits:
    #   GEMINA_SMOKE_ADD_ON=1 GEMINA_BASE_URL=https://api.staging.gemina.co \
    #   GEMINA_API_KEY=... python smoke/smoke.py
    if os.environ.get("GEMINA_SMOKE_ADD_ON"):
        rc = await _add_on_scenario(client)
        if rc != 0:
            return rc

    print("OK")
    return 0


async def _add_on_scenario(client: GeminaClient) -> int:
    """Upload a document, then add a second extraction type to it with the new
    add_extractions_and_wait helper — no re-upload — and assert the round trip
    lands on the same document."""
    fixture = Path(__file__).resolve().parent / "fixtures" / "one-page.pdf"
    print(f"add-on: uploading {fixture.name} (ocr, praetorian) ...")
    uploaded = await client.process_document(
        fixture,
        [UploadExtractionTypeEnum.OCR],
        model_type=ModelType.PRAETORIAN,
    )
    document_id = uploaded.meta.document_id if uploaded.meta else None
    if document_id is None:
        print("FAIL: upload result carried no documentId", file=sys.stderr)
        return 1
    print(f"add-on: uploaded documentId={document_id} status={uploaded.status}")

    print("add-on: add_extractions_and_wait([invoice_headers]) ...")
    result = await client.add_extractions_and_wait(
        document_id,
        [UploadExtractionTypeEnum.INVOICE_HEADERS],
    )
    if result.meta is None or result.meta.document_id != document_id:
        print("FAIL: add-on result is for a different document", file=sys.stderr)
        return 1
    n = len(result.data.extractions) if result.data and result.data.extractions else 0
    print(f"add-on: terminal status={result.status}, extractions on document={n}")
    if n < 2:
        print("FAIL: expected at least 2 extractions after the add-on", file=sys.stderr)
        return 1
    print("add-on: OK")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
