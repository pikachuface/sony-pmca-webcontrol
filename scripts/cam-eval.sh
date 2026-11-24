#!/usr/bin/env bash
# Runs a BeanShell script on the camera's debug console (DebugServer, port 8081).
# Usage: CAM=10.10.30.104 KEY=<key from camera screen> scripts/cam-eval.sh [file|-] [query]
#   query example: "thread=main&timeout=5000" or "reset=1"
set -euo pipefail
: "${CAM:?set CAM to the camera IP}"
: "${KEY:?set KEY to the debug key shown on the camera screen}"
src="${1:--}"
query="${2:-}"
curl -sS -m 330 -H "X-Debug-Key: ${KEY}" -H 'Content-Type: text/plain' \
  --data-binary "@${src}" "http://${CAM}:8081/eval${query:+?${query}}"
echo
