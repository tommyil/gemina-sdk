#!/usr/bin/env bash
# Copy the per-package READMEs into the console's docs directory, where the
# IntegrationModal's SDK toggle serves them as README_sdk_<lang>.md.
# Source of truth is THIS repo; run after each SDK release (manual v1 flow).
#
# Usage: tools/sync_console_docs.sh [path-to-gemina-console]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONSOLE="${1:-$HOME/gemina/gemina-console}"
DOCS="$CONSOLE/public/docs"

[ -d "$DOCS" ] || { echo "console docs dir not found: $DOCS" >&2; exit 1; }

declare -A MAP=(
  ["sdks/typescript/README.md"]="README_sdk_typescript.md"
  ["sdks/python/README.md"]="README_sdk_python.md"
  ["sdks/csharp/README.md"]="README_sdk_csharp.md"
  ["sdks/java/README.md"]="README_sdk_java.md"
  ["sdks/php/README.md"]="README_sdk_php.md"
  ["packages/elements/README.md"]="README_sdk_elements.md"
)

missing=0
for src in "${!MAP[@]}"; do
  if [ -f "$REPO_ROOT/$src" ]; then
    cp "$REPO_ROOT/$src" "$DOCS/${MAP[$src]}"
    echo "synced $src -> public/docs/${MAP[$src]}"
  else
    echo "WARNING: $src missing — ${MAP[$src]} NOT updated" >&2
    missing=1
  fi
done
exit $missing
