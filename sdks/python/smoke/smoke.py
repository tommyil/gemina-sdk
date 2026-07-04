"""Live smoke test: hit GET /v1/retrieval/status with the real client.

Usage:
    GEMINA_BASE_URL=https://api.gemina.co GEMINA_API_KEY=... python smoke/smoke.py

Exits non-zero on any failure.
"""

import asyncio
import os
import sys

from gemina import GeminaClient, __version__


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
    except Exception as exc:  # noqa: BLE001 - smoke test reports anything
        print(f"FAIL: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    print(f"typed result: {status!r}")
    print(f"indexedDocuments={status.indexed_documents}")
    if status.indexed_documents is None:
        print("FAIL: indexedDocuments missing from response", file=sys.stderr)
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
