#!/usr/bin/env bash
# Installs an APK on the camera over Wi-Fi, no USB needed: packs it as an SPK with Sony-PMCA-RE,
# uploads it to the running app's debug console (POST :8081/ota), and the app starts the camera's
# own installer. The app closes during the install; start it again from the application list.
# Needs a build that has /ota (installed once over USB).
# Usage: CAM=10.10.30.104 scripts/ota.sh [apk]
#   KEY      debug key (default: camera-app/debug-key.txt)
#   PMCA_RE  Sony-PMCA-RE checkout (default: tools/Sony-PMCA-RE)
#   PYTHON   Python with Sony-PMCA-RE's requirements (default: .venv/bin/python)
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
: "${CAM:?set CAM to the camera IP}"
apk="${1:-$repo/camera-app/app/build/outputs/apk/sony-pmca-webcontrol-debug-1.0.0.apk}"
key="${KEY:-$(cat "$repo/camera-app/debug-key.txt")}"
pmca="${PMCA_RE:-$repo/tools/Sony-PMCA-RE}"
python="${PYTHON:-$repo/.venv/bin/python}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
"$python" -W ignore - "$pmca" "$apk" "$tmp/app.1.spk" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
from pmca import spk
apk = open(sys.argv[2], 'rb').read()
data = spk.dump(apk)
assert spk.parse(data) == apk, 'SPK round trip failed'
open(sys.argv[3], 'wb').write(data)
print('Packed %s (%d bytes) as SPK (%d bytes)' % (sys.argv[2], len(apk), len(data)))
PY
md5="$(md5sum "$tmp/app.1.spk" | cut -d' ' -f1)"
curl -fsS -m 120 -H "X-Debug-Key: ${key}" -H 'Content-Type: application/octet-stream' \
  --data-binary "@$tmp/app.1.spk" "http://${CAM}:8081/ota?md5=${md5}"
echo
