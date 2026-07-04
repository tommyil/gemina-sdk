#!/usr/bin/env python3
"""Per-language build + live smoke checks.

Driven by ``config/smoke.json``: each language lists ordered steps; each step
is a command run inside the language's package directory, either natively or
inside a pinned Docker image (so contributors don't need every toolchain
installed). The final step of every language runs that SDK's ``smoke``
program, which calls ``GET /v1/retrieval/status`` against ``GEMINA_BASE_URL``
with ``GEMINA_API_KEY`` and asserts a 200-shaped, typed response.

Usage:
    export GEMINA_BASE_URL=... GEMINA_API_KEY=...
    python tools/smoke.py                  # all languages
    python tools/smoke.py --lang python    # one language
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
CONFIG = REPO_ROOT / "config" / "smoke.json"

# Environment forwarded into smoke programs (and Docker steps).
FORWARDED_ENV = ("GEMINA_BASE_URL", "GEMINA_API_KEY")


def run_step(lang: str, step: dict, cwd: Path) -> None:
    cmd = step["cmd"]
    if step.get("docker_image"):
        docker_cmd = [
            "docker", "run", "--rm",
            "--user", f"{os.getuid()}:{os.getgid()}",
            "-v", f"{REPO_ROOT}:/work", "-w", f"/work/{cwd.relative_to(REPO_ROOT)}",
        ]
        # Toolchains write caches to HOME; give them a writable one.
        docker_cmd += ["-e", "HOME=/tmp"]
        for var in FORWARDED_ENV:
            if os.environ.get(var):
                docker_cmd += ["-e", f"{var}={os.environ[var]}"]
        docker_cmd += [step["docker_image"]] + cmd
        cmd = docker_cmd
        cwd = REPO_ROOT
    print(f"[{lang}] +", " ".join(cmd))
    subprocess.run(cmd, check=True, cwd=cwd)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lang", action="append", help="limit to specific language(s)")
    args = parser.parse_args()

    if not os.environ.get("GEMINA_BASE_URL") or not os.environ.get("GEMINA_API_KEY"):
        sys.exit("set GEMINA_BASE_URL and GEMINA_API_KEY (the live smoke call needs them)")

    cfg = json.loads(CONFIG.read_text())
    selected = args.lang or list(cfg)
    failures = []
    for lang in selected:
        if lang not in cfg:
            sys.exit(f"unknown language {lang!r}; known: {', '.join(cfg)}")
        cwd = REPO_ROOT / cfg[lang]["cwd"]
        try:
            for step in cfg[lang]["steps"]:
                run_step(lang, step, cwd)
            print(f"[{lang}] OK")
        except subprocess.CalledProcessError as exc:
            print(f"[{lang}] FAILED: {exc}", file=sys.stderr)
            failures.append(lang)

    if failures:
        print(f"\nsmoke failures: {', '.join(failures)}", file=sys.stderr)
        return 1
    print("\nall smokes green")
    return 0


if __name__ == "__main__":
    sys.exit(main())
