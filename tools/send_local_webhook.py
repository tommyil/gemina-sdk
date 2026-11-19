#!/usr/bin/env python3
"""Send one signed webhook to a local receiver, to try a README sample without staging.

The body is the `extraction-completed-utf8-body` vector from
testdata/webhook_test_vectors.json. It is signed per Standard Webhooks v1 with
the secret given here and the current time, and POSTed to the URL. Prints the
HTTP status code. Stdlib only.

Usage:
    python tools/send_local_webhook.py URL --secret whsec_... [--id evt_a]
        [--variant N] [--tamper] [--print-curl]

    --id ID        the event id (webhook-id); send the same id twice to send a repeat
    --variant N    set data.externalId to "variant-N" before signing: the same id
                   with a different, equally valid body, as a real retry can be
    --tamper       change one byte of the body after signing (expect a 400)
    --print-curl   print the equivalent curl command instead of sending, so a
                   header can be added by hand
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import shlex
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

VECTORS = Path(__file__).resolve().parent.parent / "testdata" / "webhook_test_vectors.json"
VECTOR_NAME = "extraction-completed-utf8-body"
SECRET_PREFIX = "whsec_"


def build_body(variant: int | None) -> bytes:
    vectors = json.loads(VECTORS.read_text(encoding="utf-8"))
    body = next(v for v in vectors["valid"] if v["name"] == VECTOR_NAME)["body"]
    if variant is not None:
        document = json.loads(body)
        document["data"]["externalId"] = f"variant-{variant}"
        body = json.dumps(document, ensure_ascii=False, separators=(",", ":"))
    return body.encode("utf-8")


def sign(secret: str, event_id: str, timestamp: str, body: bytes) -> str:
    if not secret.startswith(SECRET_PREFIX):
        raise SystemExit(f"--secret must start with {SECRET_PREFIX}")
    key = base64.b64decode(secret[len(SECRET_PREFIX):], validate=True)
    digest = hmac.new(key, f"{event_id}.{timestamp}.".encode("utf-8") + body, hashlib.sha256).digest()
    return "v1," + base64.b64encode(digest).decode("ascii")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("url")
    parser.add_argument("--secret", required=True)
    parser.add_argument("--id", default="evt_0123456789abcdef0123456789abcdef")
    parser.add_argument("--variant", type=int)
    parser.add_argument("--tamper", action="store_true")
    parser.add_argument("--print-curl", action="store_true")
    args = parser.parse_args()

    body = build_body(args.variant)
    timestamp = str(int(time.time()))
    headers = {
        "content-type": "application/json",
        "webhook-id": args.id,
        "webhook-timestamp": timestamp,
        "webhook-signature": sign(args.secret, args.id, timestamp, body),
    }
    if args.tamper:
        body = body[:-1] + b" "                       # the closing brace becomes a space

    if args.print_curl:
        parts = ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}\\n", "-X", "POST"]
        for name, value in headers.items():
            parts += ["-H", f"{name}: {value}"]
        parts += ["--data-binary", body.decode("utf-8"), args.url]
        print(" ".join(shlex.quote(part) for part in parts))
        return 0

    request = urllib.request.Request(args.url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310 (a URL the caller chose)
            print(response.status)
    except urllib.error.HTTPError as error:
        print(error.code)
    except urllib.error.URLError as error:
        print(f"could not reach {args.url}: {error.reason}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
