#!/usr/bin/env bash
# Rebuilds docs/workflow-design.pdf from docs/workflow-design.html with headless Chrome.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
"${CHROME:-google-chrome}" --headless=new --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="$root/docs/workflow-design.pdf" "file://$root/docs/workflow-design.html"
