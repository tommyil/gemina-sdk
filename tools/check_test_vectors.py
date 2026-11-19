#!/usr/bin/env python3
"""Fail if a PHP copy of the webhook vectors differs from the canonical file.

The canonical files are in testdata/. PHP needs its own copies because the PHP
package is published from a subtree split of sdks/php. The API repo
(gemina-api-v2, tests/fixtures/webhook_test_vectors.json) holds another copy of
the shared file; that one is compared by hand at release time (task C13).
"""
import hashlib
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
NAMES = ["webhook_test_vectors.json", "webhook_typed_vectors.json"]


def digest(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    stale = []
    for name in NAMES:
        canonical = ROOT / "testdata" / name
        copy = ROOT / "sdks" / "php" / "tests" / "fixtures" / name
        if not copy.exists() or digest(copy) != digest(canonical):
            stale.append(copy)
    for copy in stale:
        print(f"OUT OF SYNC: {copy.relative_to(ROOT)} differs from testdata/{copy.name}", file=sys.stderr)
    return 1 if stale else 0


if __name__ == "__main__":
    sys.exit(main())
