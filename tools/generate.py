#!/usr/bin/env python3
"""Regenerate the per-language SDK clients from the frozen spec.

Driven by ``config/languages.json``. For each language:

1. run the pinned ``openapi-generator`` Docker image against
   ``specs/CURRENT`` (optionally down-converted to OpenAPI 3.0 first),
2. **wipe** the committed generated directory,
3. copy the configured subtree(s) of the generator output into it,
4. stamp a ``GENERATED_DO_NOT_EDIT`` banner file.

Hand-written helper modules live *outside* the wiped directories, so a full
regen never touches them. ``--check`` proves reproducibility: regenerating
from an unchanged spec must leave ``git status`` clean under ``sdks/``.

Usage:
    python tools/generate.py                # all languages
    python tools/generate.py --lang python  # one language
    python tools/generate.py --check       # CI: regen + assert zero diff
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
CONFIG = REPO_ROOT / "config" / "languages.json"
BUILD_DIR = REPO_ROOT / ".build"

BANNER = """\
# GENERATED — DO NOT EDIT

Everything in this directory is produced by `tools/generate.py` from the
frozen spec snapshot named in `specs/CURRENT`, and is wiped on every
regeneration. Manual changes WILL be lost.

Fixes belong in:
- `config/` (generator config / template overrides),
- the upstream API spec (gemina-api-v2), or
- the hand-written helper layer outside this directory.

Spec snapshot: {snapshot}
"""


def run(cmd: list[str], **kwargs) -> None:
    print("+", " ".join(map(str, cmd)))
    subprocess.run(cmd, check=True, **kwargs)


def current_spec() -> Path:
    name = (REPO_ROOT / "specs" / "CURRENT").read_text().strip()
    spec = REPO_ROOT / "specs" / name
    if not spec.exists():
        sys.exit(f"specs/CURRENT points at missing snapshot {name!r}")
    return spec


def downconverted_spec(spec: Path) -> Path:
    """OpenAPI 3.1 → 3.0 for generators that can't take 3.1 (see config/README.md)."""
    out = BUILD_DIR / f"{spec.stem}-3.0.json"
    if not out.exists():
        BUILD_DIR.mkdir(exist_ok=True)
        run([
            "npx", "--yes", "@apiture/openapi-down-convert@1.0.0",
            "--input", str(spec), "--output", str(out),
        ])
    return out


def generate_language(name: str, lang_cfg: dict, image: str, spec: Path) -> None:
    print(f"\n=== {name} ===")
    spec_in = downconverted_spec(spec) if lang_cfg.get("downconvert") else spec
    out_dir = BUILD_DIR / name
    shutil.rmtree(out_dir, ignore_errors=True)

    # Everything the container needs (spec, config, templates, output) lives
    # under the repo root, so a single mount suffices. --user keeps the
    # generated files owned by the invoking user rather than root.
    uid = f"{os.getuid()}:{os.getgid()}"
    cmd = [
        "docker", "run", "--rm", "--user", uid,
        "-v", f"{REPO_ROOT}:/local",
        image, "generate",
        "-i", f"/local/{spec_in.relative_to(REPO_ROOT)}",
        "-g", lang_cfg["generator"],
        "-c", f"/local/{lang_cfg['config']}",
        "-o", f"/local/{out_dir.relative_to(REPO_ROOT)}",
    ]
    if lang_cfg.get("templates"):
        cmd += ["-t", f"/local/{lang_cfg['templates']}"]
    for prop in lang_cfg.get("global_properties", []):
        cmd += ["--global-property", prop]
    run(cmd)

    snapshot = spec.name
    for rule in lang_cfg["copy"]:
        src = out_dir / rule["from"]
        dst = REPO_ROOT / rule["to"]
        if not src.exists():
            sys.exit(f"{name}: expected generator output {src} not found")
        shutil.rmtree(dst, ignore_errors=True)
        shutil.copytree(src, dst)
        (dst / "GENERATED_DO_NOT_EDIT.md").write_text(BANNER.format(snapshot=snapshot))
        print(f"  {rule['from']} -> {rule['to']}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lang", action="append", help="limit to specific language(s)")
    parser.add_argument("--check", action="store_true", help="fail if regeneration produces a diff")
    args = parser.parse_args()

    cfg = json.loads(CONFIG.read_text())
    image = cfg["generator_image"]
    spec = current_spec()
    languages = cfg["languages"]
    selected = args.lang or list(languages)

    for name in selected:
        if name not in languages:
            sys.exit(f"unknown language {name!r}; known: {', '.join(languages)}")
        generate_language(name, languages[name], image, spec)

    if args.check:
        diff = subprocess.run(
            ["git", "status", "--porcelain", "--", "sdks/"],
            cwd=REPO_ROOT, capture_output=True, text=True, check=True,
        ).stdout.strip()
        if diff:
            print(f"\nregeneration is NOT reproducible — dirty paths:\n{diff}", file=sys.stderr)
            return 1
        print("\nregeneration reproducible: zero diff under sdks/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
