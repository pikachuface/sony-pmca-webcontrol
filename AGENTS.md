# AGENTS.md — AI Coding Agent Guide

Project: **Sony PMCA WebControl** — Android 2.3 (API 10) in-camera HTTP/RPC bridge (`camera-app/`), React/TypeScript web frontend (`web-client/`), and optional Python 3 host companion server (`host-server/`).

## Build & Flashing Commands

* **Build camera APK (`camera-app/`)**:
  * Must use **JDK 8** (Android Gradle plugin `2.1.x` fails on JDK 9+):
    ```bash
    cd camera-app && JAVA_HOME=/usr/lib/jvm/java-8-openjdk-amd64 ./gradlew assembleDebug
    ```
  * Output: `camera-app/app/build/outputs/apk/sony-pmca-webcontrol-debug-1.0.0.apk`

* **Flash APK to camera over USB**:
  * **Do NOT use `adb`** — Sony Alpha cameras do not expose standard Android `adb` debugging.
  * Use `Sony-PMCA-RE` via the repo's `.venv` Python:
    ```bash
    .venv/bin/python tools/Sony-PMCA-RE/pmca-console.py install -f camera-app/app/build/outputs/apk/sony-pmca-webcontrol-debug-1.0.0.apk
    ```
  * **Over Wi-Fi** (once a build with `/ota` is installed): `CAM=<ip> scripts/ota.sh` packs the APK as SPK with Sony-PMCA-RE and installs it through the debug console; the app closes, start it again on the camera.
  * **Linux desktop GVFS note**: If `pmca-console.py` fails with `USBError: [Errno 16] Resource busy`, unmount the auto-mounted MTP volume first:
    ```bash
    gio mount -l | grep -i gphoto2
    gio mount -u gphoto2://Sony_ILCE-6000_.../
    ```

* **Build & type-check web client (`web-client/`)**:
  ```bash
  cd web-client && npx tsc --noEmit --noUnusedLocals --noUnusedParameters && npm run build
  ```
  * Output: single self-contained `web-client/dist/index.html`.

* **Run or syntax-check host companion server (`host-server/`)**:
  ```bash
  python3 -m py_compile host-server/server.py
  python3 host-server/server.py --camera http://192.168.0.250:8080
  ```

## Key Documentation
* [docs/DESIGN.md](./docs/DESIGN.md) — Overall architecture, threading/lock separation, closed-loop control, and LiveView slot design
* [docs/API.md](./docs/API.md) — HTTP/RPC endpoints, `highlevel` targets, `/api/events`, and `/api/liveview*`
* [docs/USER_GUIDE.md](./docs/USER_GUIDE.md) — Camera compatibility, flashing, and user operation
* [docs/DEVELOPER_GUIDE.md](./docs/DEVELOPER_GUIDE.md) — Build setup, testing loop, and extension points

## Fork Notes (WebControl A7)

* **Build without a local toolchain**: `scripts/build.sh` (Docker, pinned JDK 8 / Android 10 / build-tools 25.0.2 / Node 22). Debug builds are signed with the committed `camera-app/debug.keystore`.
* **Application id** is `io.github.pikachuface.webcontrol` (label *WebControl A7*); Java packages stay `com.sony.pmca.webcontrol`. Installing a build signed with another key over an existing install fails with PMCA `Communication error 100`.
* **ILCE-7 focus**: no focus drive (`getMaxFocusDriveSpeed()` is `0`, no `FocusDrive` events), so `highlevel.setFocusPosition` cannot work there. The only focus control is `shiftFocusPosition(n)`, an absolute offset from the last AF position, limited to ±16 (verified on device: repeated `+16` stays put). Use `highlevel.setFocusOffset(n)` / `highlevel.shiftFocus(steps)`; full-range manual focus is impossible on this body.
* **ILCE-7 AF-C and faces**: `highlevel.setAfMode` (`AfModeController`) holds `Camera.autoFocus()` with `af-mode` `af-c` for continuous AF and streams `Faces` events; focus area Wide is the parameter value `multi`. After any AF-C, call a successful `autoFocusAt` before `shiftFocusPosition` (it blocked forever on an invalid AF base and froze the camera).
* **ILCE-7 Wi-Fi**: the DHCP renewal at half the lease always times out (logcat `DHCP renewal failed: Timed out waiting for DHCP Renew to finish`), Android disconnects and the supplicant stays down until `reconnect()`. The watchdog in `MacroServerActivity` reconnects 2 s after the drop; a fresh DHCP request then takes about 6 s. A long router lease is the only way to make the drops rare.
* **Debug console**: port 8081 runs BeanShell scripts in the app (`scripts/cam-eval.sh`, see `docs/API.md`). Use it to try camera API sequences before changing Java code; the key is in `camera-app/debug-key.txt` (gitignored). Wi-Fi state changes are logged to `PMCADEMO/LOG.TXT` on the card.
* Focus stacking, OpenFocus and `/local-api/*` were removed; do not reintroduce them without a focus-position source.
