#!/usr/bin/env python3
"""Freeze an OpenAPI spec snapshot into specs/.

The SDKs are never generated from a live URL — always from a frozen,
committed snapshot, so every release is reproducible. This script fetches
``<base-url>/openapi.json`` (or reads a local dump), sanity-checks the
invariants the generators rely on, and writes::

    specs/gemina-<info.version>.json   (pretty-printed, stable key order)
    specs/CURRENT                      (single line: the snapshot filename)

Snapshots are immutable: re-freezing an existing version requires --force.

Usage:
    python tools/fetch_spec.py --base-url https://api.gemina.co
    python tools/fetch_spec.py --from-file /path/to/openapi.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SPECS_DIR = REPO_ROOT / "specs"

# Method names in generated clients come from operationId; anything with URL
# residue (the FastAPI default) means the upstream spec-hardening isn't live.
OPERATION_ID_RE = re.compile(r"^[a-z][a-z0-9_]*$")
HTTP_METHODS = {"get", "post", "put", "patch", "delete"}


def load_spec(args: argparse.Namespace) -> dict:
    if args.from_file:
        raw = Path(args.from_file).read_text(encoding="utf-8")
    else:
        url = args.base_url.rstrip("/") + "/openapi.json"
        print(f"fetching {url}")
        with urllib.request.urlopen(url, timeout=30) as resp:  # noqa: S310 (https URL)
            raw = resp.read().decode("utf-8")
    return json.loads(raw)


def validate(spec: dict) -> list[str]:
    """Return a list of violations of the invariants the generators need."""
    problems = []
    if not spec.get("openapi", "").startswith("3."):
        problems.append(f"unexpected openapi version: {spec.get('openapi')!r}")
    info = spec.get("info", {})
    if not info.get("version"):
        problems.append("info.version missing")
    if not info.get("title"):
        problems.append("info.title missing")

    ops = [
        (path, method, op)
        for path, methods in spec.get("paths", {}).items()
        for method, op in methods.items()
        if method in HTTP_METHODS
    ]
    if not ops:
        problems.append("spec has no operations")

    seen_ids: set[str] = set()
    for path, method, op in ops:
        op_id = op.get("operationId", "")
        if not OPERATION_ID_RE.match(op_id) or "api_v1" in op_id:
            problems.append(f"dirty operationId {op_id!r} on {method.upper()} {path}")
        if op_id in seen_ids:
            problems.append(f"duplicate operationId {op_id!r}")
        seen_ids.add(op_id)
        if not op.get("tags"):
            problems.append(f"untagged operation {method.upper()} {path}")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--base-url", help="API base URL to fetch /openapi.json from")
    source.add_argument("--from-file", help="freeze from a local openapi.json dump")
    parser.add_argument("--force", action="store_true", help="allow overwriting an existing snapshot")
    parser.add_argument(
        "--server-url",
        help="value for servers[0].url (defaults to --base-url). FastAPI emits no "
        "servers block, and without one the generators default to localhost.",
    )
    args = parser.parse_args()
    server_url = args.server_url or args.base_url
    if not server_url:
        parser.error("--server-url is required with --from-file")

    spec = load_spec(args)
    spec["servers"] = [{"url": server_url.rstrip("/")}]
    problems = validate(spec)
    if problems:
        print("spec failed validation:", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 1

    version = spec["info"]["version"]
    out_path = SPECS_DIR / f"gemina-{version}.json"
    if out_path.exists() and not args.force:
        print(f"refusing to overwrite frozen snapshot {out_path} (use --force)", file=sys.stderr)
        return 1

    SPECS_DIR.mkdir(exist_ok=True)
    # Stable serialization so identical specs produce identical bytes.
    out_path.write_text(
        json.dumps(spec, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    (SPECS_DIR / "CURRENT").write_text(out_path.name + "\n", encoding="utf-8")

    n_ops = sum(
        1
        for methods in spec["paths"].values()
        for m in methods
        if m in HTTP_METHODS
    )
    print(f"froze {out_path.relative_to(REPO_ROOT)} ({n_ops} operations) and updated specs/CURRENT")
    return 0


if __name__ == "__main__":
    sys.exit(main())
