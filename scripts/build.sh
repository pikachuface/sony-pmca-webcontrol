#!/usr/bin/env bash
# Build the camera APK (with the embedded web UI) and the standalone web client inside
# the pinned Docker image from docker/Dockerfile.
#
#   scripts/build.sh            # APK + web-client/dist/index.html
#   scripts/build.sh shell      # interactive shell in the build container
#
# Outputs:
#   camera-app/app/build/outputs/apk/sony-pmca-webcontrol-debug-<version>.apk
#   web-client/dist/index.html
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="sony-pmca-webcontrol-build:1"
cache_volume="sony-pmca-webcontrol-cache"

docker build -t "$image" "$repo/docker"
docker volume create "$cache_volume" >/dev/null

# The cache volume is created root-owned; hand it to the host user once.
docker run --rm -v "$cache_volume:/cache" "$image" \
  sh -c "mkdir -p /cache/gradle /cache/npm /cache/home && chown -R $(id -u):$(id -g) /cache"

# `:z` relabels the checkout for container access on SELinux hosts (e.g. openSUSE
# Tumbleweed); it is a no-op elsewhere. Undo with `restorecon -R <checkout>`.
opts=(--rm --user "$(id -u):$(id -g)" -v "$repo:/src:z" -v "$cache_volume:/cache" -w /src)

if [[ "${1:-}" == "shell" ]]; then
  exec docker run -it "${opts[@]}" "$image" bash
fi

run=(docker run "${opts[@]}" "$image")

"${run[@]}" bash -euo pipefail -c '
  cd web-client
  npm ci
  npm run build
  cd ../camera-app
  ./gradlew --no-daemon assembleDebug
'

ls -l "$repo"/camera-app/app/build/outputs/apk/*.apk "$repo"/web-client/dist/index.html
