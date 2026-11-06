#!/usr/bin/env bash
# Local Temporal dev server, with the two search attributes the workflow uses.
set -euo pipefail
exec "${TEMPORAL_CLI:-temporal}" server start-dev \
  --ip 127.0.0.1 --port "${TEMPORAL_PORT:-7243}" --ui-port "${TEMPORAL_UI_PORT:-8243}" \
  --search-attribute SourceOrderNumber=Keyword \
  --search-attribute DeliveryStage=Keyword \
  --search-attribute DeliveryOverdue=Bool \
  --log-level warn
