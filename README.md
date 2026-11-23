# WebControl A7 (`sony-pmca-webcontrol` fork)

A fork of [hhb/sony-pmca-webcontrol](https://github.com/hhb/sony-pmca-webcontrol) tuned for the
original **Sony A7 (`ILCE-7`)**. Like upstream, it is an in-camera PlayMemories (PMCA) app that joins
your home Wi-Fi and serves an MJPEG live view, a web UI and an HTTP JSON-RPC API, so the camera can be
controlled from any browser on the LAN.

## What this fork changes

* **Focus fine-tuning knob instead of focus drive.** The ILCE-7 firmware ignores
  `CameraEx.startOneShotFocusDrive` (`getMaxFocusDriveSpeed()` is `0`, and no `FocusDrive` events
  arrive, with Sony and third-party lenses alike), so upstream's focus slider, stepping buttons and
  focus stacking never worked on it. The only focus control left is `CameraEx.shiftFocusPosition(n)`,
  which sets focus to **the last AF position + n**, with n limited to ±16 (measured: repeating
  `+16` does not move further, `+8` afterwards lands in between). An app therefore cannot sweep
  the whole focus range on this body, only fine-tune around the AF point. The Focus panel is
  **[−] knob [+]** with end stops at ±16: click the live view to AF, then turn the knob with the
  scroll wheel, a vertical drag or the arrow keys. Each detent moves the offset by **Step size**
  (default 4), or by 1 while **Shift** is held; **Back to AF** returns to offset 0.
* **Focus stacking and OpenFocus auto-merge removed**, along with the host server's `/local-api/*`.
* **Magnify tool removed** from the live view; a **full screen** button was added.
* **Reproducible build in Docker** (`scripts/build.sh`), with a committed debug key so APKs from any
  machine install as updates of each other.
* **Own application id** (`io.github.pikachuface.webcontrol`, shown as *WebControl A7*), so it installs
  next to upstream's app instead of conflicting with it.

Planned: timelapse (shooting duration + FPS + video length → interval), video recording, AF area /
face detection controls.

## Camera support

Developed and tested on the **ILCE-7 with firmware 3.20** (`version.platform` `2.3`). Everything except
the focus knob, output crop and preview zoom is upstream code and should behave as upstream on other PMCA bodies (see
[docs/USER_GUIDE.md](./docs/USER_GUIDE.md)). The focus knob relies on `shiftFocusPosition`, which
upstream found to block the main thread on the `ILCE-6000`; it is untested on other bodies.

Remote focus needs an E-mount lens with electronic contacts and an AF motor. Live view, exposure,
autofocus and shutter release work with any lens.

## Build

Only Docker is needed:

```bash
scripts/build.sh
```

This builds `camera-app/app/build/outputs/apk/sony-pmca-webcontrol-debug-<version>.apk` (with the web
UI embedded) and the standalone `web-client/dist/index.html`. See
[docs/DEVELOPER_GUIDE.md](./docs/DEVELOPER_GUIDE.md) for the toolchain and a local (non-Docker) build.

## Install

Install the APK over USB with [Sony-PMCA-RE](https://github.com/ma1co/Sony-PMCA-RE) (camera in **MTP**
USB mode); this installs an app and does not modify the camera firmware:

```bash
python pmca-console.py install -f sony-pmca-webcontrol-debug-1.0.0.apk
```

Then set your Wi-Fi under **Network → Access Point Set.** on the camera, start **WebControl A7** from
**Application → Application List**, and open the address shown on the camera screen
(`http://<camera-ip>:8080`) in a browser. Step-by-step instructions are in
[docs/USER_GUIDE.md](./docs/USER_GUIDE.md).

## Documentation

* [docs/USER_GUIDE.md](./docs/USER_GUIDE.md): compatibility, installing, using the web UI
* [docs/DEVELOPER_GUIDE.md](./docs/DEVELOPER_GUIDE.md): build, testing loop, extending
* [docs/API.md](./docs/API.md): HTTP and RPC API
* [docs/DESIGN.md](./docs/DESIGN.md): architecture
* [AGENTS.md](./AGENTS.md): guide for AI coding agents

## Repository structure

* `camera-app/`: Android 2.3 (API 10) in-camera APK built on `OpenMemories-Framework` and `NanoHTTPD`
* `web-client/`: React + TypeScript + Vite web UI and the `CameraClient` SDK (`src/api/cameraClient.ts`)
* `host-server/`: optional Python 3 HTTPS server that serves the web UI and proxies `/api/*` to the
  camera, so browsers allow saving straight into a local folder
* `docker/`, `scripts/build.sh`: pinned build environment

## License

[MIT](./LICENSE). Original work by the upstream authors; see the upstream repository.
