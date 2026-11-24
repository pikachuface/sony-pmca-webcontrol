# Sony PMCA WebControl — HTTP & RPC API Reference (`API.md`)

The camera runs an embedded HTTP server (`MacroHttpServer`, `NanoHTTPD` on port `80` with fallback to `8080`).

* **CORS**: All endpoints return `Access-Control-Allow-Origin: *` and support `OPTIONS` preflight requests.
* **Main-Thread Timeout**: Reflective RPC calls execute on the Android main thread with a **3000 ms timeout** (returning HTTP `504 Gateway Timeout` if camera firmware blocks).
* **Error Format**: Failed API calls return `{"ok": false, "error": "..."}`.

---

## Summary of Endpoints

| Method & Path | Description |
|---|---|
| `POST /api/call` | Universal reflective RPC (single or batched calls) |
| `GET  /api/describe` | Introspect all callable targets, method names, and signatures |
| `GET  /api/state` | Latest cached snapshots from all `CameraEx` listeners + `seq` |
| `GET  /api/events` | Long-polling callback event stream |
| `GET  /api/liveview.mjpeg` | Adaptive `multipart/x-mixed-replace` 640px JPEG stream (up to 3 concurrent clients) |
| `GET/POST /api/liveview/close` | Explicitly close an active MJPEG client by `cid` |
| `GET  /api/liveview.jpg` | Single latest 640px JPEG live preview frame |
| `GET  /api/photos` | Non-recursive `DCIM` folder and photo listing |
| `GET  /api/photos/latest` | Download the latest captured JPEG (`?index=N` for one specific capture) |
| `GET/POST /api/timelapse` | Timelapse status; start (`{action:"start", frames, intervalMs}`) or stop (`{action:"stop"}`) |
| `GET  /api/output.mjpeg`, `/api/output.jpg` | Live view with the output crop applied |
| `GET/POST /api/output/crop` | Output crop (`{enabled, x, y, w, h}`, normalized, unrotated image) |
| `GET  /api/photos/download` | Download a specific SD card file (`.JPG` or `.ARW`) |
| `POST :8081/eval`, `GET :8081/logcat`, `POST :8081/ota` | Debug console on its own port (BeanShell scripts, logcat, install over Wi-Fi); needs the debug key |
| `GET  /api/photos/last-shot` | Files of the newest shot on the card (`{ files: [{name, path, size}] }`; RAW+JPEG gives two) |
| `GET  /api/log` | Plain-text camera debug/crash log |

---

## 1. Universal Reflective RPC (`POST /api/call`)

### Single Call Format
```json
{
  "target": "camera",
  "method": "adjustAperture",
  "args": [2]
}
```

### Batch Call Format
Executes sequentially on the camera main thread in a single HTTP round-trip. **Consecutive `modifier` `set*` calls are automatically coalesced into a single `setParameters()` IPC call:**
```json
{
  "calls": [
    { "target": "modifier", "method": "setISOSensitivity", "args": [100] },
    { "target": "modifier", "method": "setDROMode",        "args": ["off"] },
    { "target": "camera",   "method": "adjustShutterSpeed", "args": [-2] }
  ]
}
```

### Supported Targets
| `target` | Underlying Object | Behavior & Notes |
|---|---|---|
| `"camera"` | `com.sony.scalar.hardware.CameraEx` | Calls instance methods directly (excluding lifecycle/listener methods). Also supports synthetic `"capabilities"` returning `LensInfo` + all `ParametersModifier.is*Supported()` flags. |
| `"modifier"` | `CameraEx.ParametersModifier` | `get*`/`is*` automatically invoke on `getParameters()`. `set*` automatically invoke on `createEmptyParameters()` + `setParameters()`. |
| `"params"` | `android.hardware.Camera.Parameters` | Whitelisted `get`, `getInt`, `flatten`, `set`, `get/setExposureCompensation`, `get/setFocusMode`, `get/setWhiteBalance`, `get/setSceneMode`. |
| `"static:ScalarProperties"` | `com.sony.scalar.sysutil.ScalarProperties` | Read-only static getters (`getFirmwareVersion`, `getString`, `getInt`, `getIntArray`, `getByteArray`, `getSupportedPictureSizes`). |
| `"static:Settings"` | `com.sony.scalar.sysutil.didep.Settings` | `getTargetMediaId`, `getUsingMedia`, `isLiveAndRec`. |
| `"static:Temperature"` | `com.sony.scalar.sysutil.didep.Temperature` | `getStatus` — instantiates, reads `Temperature.Status` public fields, and releases safely. |
| `"static:System"` | Android System / `BatteryManager` | `getBattery` — returns `{ level, scale, percent, status, plugged }`. |
| `"highlevel"` | `CameraGoalController` | Device-side event-driven closed-loop setters (`setFocusPosition`, `setAperture`, `setShutterSpeed`, `setZoomPosition`) and the focus offset methods `setFocusOffset` / `shiftFocus`. Runs on HTTP worker thread without blocking camera UI. |

### High-Level Closed-Loop APIs (`target: "highlevel"`)
Sony `CameraEx` does not expose absolute setters for focus, aperture, shutter speed, or optical zoom — only relative stepping methods. `CameraGoalController` drives these in a tight local closed loop using hardware listener callbacks:

* **`setFocusPosition(targetPos[, tolerance])`**: Drives MF position using `startOneShotFocusDrive` until within `tolerance` (default `2`). Needs focus drive support; the `ILCE-7` has none (`getMaxFocusDriveSpeed()` is `0`) and fails with `Focus position unavailable`.
* **`autoFocusAt(normX, normY)`**: One AF-S autofocus at the normalized live view point: the spot moves there, and the Wide or Center area switches to Spot (see `setAfMode`). Then manual focus, so focus stays put for shots and the focus offset. It waits 300 ms after the AF callback before switching to manual: switching at once froze the `ILCE-7` lens short of the focus point (live view got sharp, then blurred). Returns `{ focused, superseded, timedOut, x, y, position }`.
* **`setFocusOffset(offset)`**: Sets focus to the last autofocus position plus `offset` steps, clamped to `±getMaxFocusShift()` (16 on the `ILCE-7`), with one `CameraEx.shiftFocusPosition(offset)` call. `shiftFocusPosition` is not a relative move: on the `ILCE-7` repeating `shiftFocusPosition(16)` leaves focus where the first call put it. Refused until an `autoFocusAt` has succeeded (calling `shiftFocusPosition` before any AF blocked the `ILCE-7` main thread); each successful `autoFocusAt` resets the offset to `0`. Returns `{ ready, offset, min, max, requested, accepted, atLimit }`.
* **`shiftFocus(steps)`**: `setFocusOffset(currentOffset + steps)`.
* **`setAfMode({ continuous?, faces?, area?, spotSize?, x?, y?, refocus? })`**: Focus area, continuous AF and face detection; missing fields keep their value.
  * `area`: `"wide"` (the body's Wide area, parameter value `multi`; `wide` is listed but refused on the `ILCE-7`), `"center"` or `"spot"` (flexible spot of `spotSize` `"small"`, `"medium"` or `"large"`, body value `midium`). `x`, `y` (0..1 of the unrotated live view) move the spot and imply `"spot"`. Focus area and spot size are body settings: the app takes them over on start.
  * Coordinates: the body uses -1000..1000 over the whole live view frame for focus points, focus areas and faces. The spot centre is clamped to the range `getFocusAreaInfos` reports (-855..856, -826..827 on the `ILCE-7`); that range is wider than the AF area (-786..787, -826..827), which is why the AF area is not the frame. (Earlier builds mapped a click onto the AF area, so focus landed up to 10% of the frame too far towards the centre.)
  * `continuous: true` switches the body to AF-C (`focus-mode` `auto`, `af-mode` `af-c`) and holds `Camera.autoFocus()` like a half-press, so the camera keeps refocusing by itself until `continuous: false` (then manual focus where AF-C left the lens, AF-S again). While AF-C runs, `autoFocusAt(x, y)` moves the spot there (Wide and Center switch to Spot; `refocus: true` restarts AF-C in the current area), and `setFocusOffset` is refused; every AF-C start clears the focus offset base, so the knob needs a new single AF afterwards. AF-C status comes from the `AutoFocusDone` events (`0` cleared, `1` locked, `2` cannot lock, `4` continuous). The `ILCE-7` has no tracking (lock-on AF) API.
  * `faces: true` sets `face-detection-mode` `auto` and streams detected faces; the body then prefers faces for AF. Face detection is a body setting and stays on after the app closes; the app picks it up on start.
  * Returns the new state plus `focused: true`.
* **`getAfMode()`**: `{ continuous, faces, area, spotSize, x, y, window: { x, y, w, h } }`, also state key `afMode` and the `AfMode` event. `x`, `y` is the spot centre as the body clamped it; `window` the focus area (spot, center rectangle or the Wide AF area) as the body reports it, normalized to the unrotated live view.
* **`getCaptureSettings()`**: Still image quality from the body's parameters: `{ format, formatValues, jpegQuality, jpegQualityValues, imageSize, imageSizeValues, aspect, aspectValues, pictureSize }`. Keys: `storage-fmt`, `jpeg-quality`, `image-size`, `image-aspect`, `picture-size`. `ILCE-7` values: format `jpeg` / `raw` / `rawjpeg`, jpegQuality `95` / `50` / `25` (its three menu entries Extra fine, Fine, Standard), imageSize `large` / `midium` / `small` (Sony's spelling), aspect `3:2` / `16:9`. There is no uncompressed RAW value on the `ILCE-7`.
* **`setCaptureSettings({ format?, jpegQuality?, imageSize?, aspect? })`**: Writes the given fields in one partial parameter write after checking each against the body's `-values` list (an unknown value fails with the list), then returns `getCaptureSettings()` as read back. Also published as state `capture` and event `CaptureSettings`, which the camera's own menu changes trigger too.
* State key `focusShift` (`{ ready, offset, min, max }`) and the `FocusShift` event carry the current offset.
* State key `faces` and the `Faces` event: `{ faces: [{ x, y, w, h, id }] }`, normalized to the unrotated live view frame (the body reports -1000..1000 over the whole frame). Sent only when a box moved by at least 1% of the frame, at most about 6 times a second; an empty list when the faces are gone or detection is switched off.
* **`setAperture(fValue100)`**: Steps `incrementAperture` / `decrementAperture` until reaching `fValue100` (e.g., `800` for `F8.0`, clamped to `currentAvailableMin`..`currentAvailableMax`).
* **`setShutterSpeed(numerator, denominator)`**: Steps `incrementShutterSpeed` / `decrementShutterSpeed` until reaching `numerator / denominator` seconds (e.g., `[1, 125]` for `1/125s`).
* **`setZoomPosition(opticalPosition[, tolerance])`**: Steps `startZoom` / `stopZoom` until reaching `opticalPosition` (default tolerance `1`).

**Concurrency & Preemption:**
* **Cross-parameter parallel**: Focus, aperture, shutter, and zoom each have independent state slots and can run concurrently.
* **Same-parameter latest-wins**: Sending a new target for the same parameter immediately supersedes any in-flight call (`superseded: true`) and steers directly to the new target.

```json
// POST /api/call
{ "target": "highlevel", "method": "setFocusPosition", "args": [350, 2] }

// Response
{
  "ok": true,
  "target": "highlevel",
  "method": "setFocusPosition",
  "result": { "converged": true, "superseded": false, "stalled": false, "position": 350, "target": 350, "steps": 6 }
}
```

### Automatic JSON ↔ Java Conversion
* **Arguments**:
  * Primitives & strings (`int`, `long`, `float`, `double`, `boolean`, `String`) convert automatically.
  * `int[]` / `byte[]` / `String[]`: pass a JSON array (e.g., `[1, 2, 3]`).
  * `android.util.Pair<Integer, Integer>`: pass a 2-element JSON array (e.g., `[0, 0]`).
  * Sony POJO structs (`SelectedColor`, `ExifInfo`, etc.): pass a JSON object matching public field names.
* **Overload Resolution**: Matched by method name, argument count, and JSON value type. Unmatched calls return candidate signatures in the error message.
* **Return Values**: Primitives, `Pair` → `[first, second]`, `List`/arrays → JSON array, and Sony structs (`LensInfo`, `WideTele`, `Temperature.Status`, etc.) → JSON object of all public non-static fields.

### Security Blacklist
To prevent destabilizing the camera session or overwriting event hooks, the following are blocked:
* `open`, `reopen`, `release`, `getNormalCamera`, `create*`, `withSupportedParameters`, `tryIgnoreInhibit`, `shiftFocusPosition` (blocks/hangs on `ILCE-6000` main thread; use `highlevel.setFocusOffset` instead)
* All `set*Listener`, `set*Callback`, and methods taking interface/callback arguments (callbacks are handled centrally and streamed via `/api/events`).

> **Caution (Preview Pipeline Rebuild):** Setting structural parameters such as `setImageSize`, `setImageAspectRatio`, `setRawRecMode`, `setPictureStorageFormat`, or `setDriveMode` may cause the camera firmware to rebuild its preview pipeline, briefly interrupting LiveView.

---

## 2. Self-Documenting Introspection (`GET /api/describe`)

Lists all callable targets, method names, parameter types, and return types discovered via reflection.

* **`GET /api/describe`**: Returns all targets and methods.
* **`GET /api/describe?target=camera&q=Focus`**: Filters by target and case-insensitive substring on method name.

---

## 3. State & Real-Time Event Bus

### `GET /api/state`
Returns the latest cached snapshots from all registered `CameraEx` listeners plus the monotonic event sequence number (`seq`).

```json
{
  "ok": true,
  "seq": 1042,
  "aperture": { "currentAperture": 560, "currentAvailableMin": 350, "currentAvailableMax": 2200 },
  "shutter": {
    "currentShutterSpeed_n": 1, "currentShutterSpeed_d": 125,
    "currentAvailableMin_n": 1, "currentAvailableMin_d": 4000,
    "currentAvailableMax_n": 30, "currentAvailableMax_d": 1
  },
  "focus": { "currentPosition": 312, "maxPosition": 847 },
  "zoom": { "opticalPosition": 0, "opticalMagnification": 100, "digitalPosition": 0, "digitalMagnification": 100, "stopped": true },
  "autoIso": 400,
  "focalLength": 50,
  "powerZoom": 0,
  "previewMagnification": { "enabled": false, "ratio": 0 },
  "lastStoreImage": { "status": 0, "DirectoryName": "100MSDCF", "FileName": "DSC01234.JPG" },
  "lastShutterStatus": 0,
  "capturing": false,
  "lens": { "LensName": "FE 90mm F2.8 Macro G OSS", "LensType": "E-mount", "FixedAperture": false },
  "wifi": { "ip": "192.168.0.250", "port": 8080 }
}
```

> **Raw Units:**
> * `Aperture`: `F-number * 100` (e.g., `560` = `F5.6`, `280` = `F2.8`).
> * `Shutter`: fraction `n / d` seconds (e.g., `1/125`s or `30/1`s).
> * `Zoom magnification`: `100` = `1.0x`, `140` = `1.4x`, `200` = `2.0x`.
> * `Focus direction`: `0` = `NEAR`, `1` = `FAR`.
> * `Zoom direction`: `0` = `TELE` (zoom in), `1` = `WIDE` (zoom out).

### `GET /api/events?since=<seq>&timeout=<sec>`
Long-polling endpoint backed by a 256-entry ring buffer. Blocks until at least one event with `seq > since` arrives, or until `timeout` seconds elapse (`0..30`, default `10`).

**Emitted Event Types:**
* `ApertureChange` — `{ currentAperture, currentAvailableMin, currentAvailableMax }`
* `ShutterSpeedChange` — `{ currentShutterSpeed_n, currentShutterSpeed_d, currentAvailableMin_*, currentAvailableMax_* }`
* `AutoISOSensitivity` — `{ iso }`
* `FocusDrive` — `{ currentPosition, maxPosition }`
* `AutoFocusStart` / `AutoFocusDone` — `{ status, focusAreaIds }`
* `ZoomChange` — `{ opticalPosition, opticalMagnification, digitalPosition, digitalMagnification, digitalZoomType, stopped }`
* `FocalLengthChange` — `{ focalLength }`
* `PowerZoom` — `{ status }`
* `PreviewMagnification` / `PreviewMagnificationInfo` — `{ enabled, ratio, pos }`
* `Shutter` — `{ status }` (`0` = OK, `1` = CANCELED, `2` = ERROR)
* `CaptureStart` / `CaptureEnd` — `{ capturing, reason }`
* `Jpeg` — `{ size, captureIndex }` (`captureIndex` counts captures since app start; pass it to `/api/photos/latest?index=`)
* `Timelapse` — same object as `GET /api/timelapse`
* `FocusShift` — `{ ready, offset, min, max }`
* `AfMode` — `{ continuous, faces, area, spotSize, x, y, window }`
* `Faces` — `{ faces: [{ x, y, w, h, id }] }` (normalized; see `setAfMode`)
* `OutputCrop` — same object as `GET /api/output/crop`
* `StoreImageComplete` — `{ status, DirectoryName, FileName, DirectoryNo, FileNo, MediaId, files }`, where `files` lists the stored files of the shot as `[{ name, path, size }]` (`DCIM/<DirectoryName>/<base>.ARW` and `.JPG`, whichever exist; empty when the names could not be resolved, then use `/api/photos/last-shot`)
* `CaptureSettings` — same object as `highlevel.getCaptureSettings()`
* `SettingChanged` — `{ types: [...] }`
* `EquipmentChange` — `{ deviceType, status }`
* `Error` — `{ error }`

---

## 4. LiveView & Photo Downloads

* **`GET /api/liveview.mjpeg?cid=<clientId>`**: Continuous `multipart/x-mixed-replace` 640px hardware JPEG stream from `CameraSequence` (up to 3 concurrent clients; if full, the oldest client is evicted; if the same `cid` reconnects, its previous stream is replaced immediately).
* **`GET|POST /api/liveview/close?cid=<clientId>`**: Immediately closes and releases the MJPEG stream matching `cid` (designed for `navigator.sendBeacon` / `fetch(..., { keepalive: true })` on tab hide, pause, or page unload). Returns `{"ok": true, "closed": true|false}`.
* **`GET /api/liveview.jpg`**: Latest 640px hardware JPEG frame from `CameraSequence`.
* **`GET /api/photos?dir=<relPath>&limit=100`**: Non-recursive directory listing under `DCIM` (sorted descending). Omit `dir` to list `DCIM` folders (e.g., `100MSDCF`, `101MSDCF`); pass `?dir=100MSDCF` to list photos in that folder. Returns `{ dir, totalPhotosInDir, dirs: [...], photos: [...] }`.
* **`GET /api/photos/latest`**: Downloads the latest captured JPEG (from in-memory capture buffer or SD card), with header `X-Capture-Index`. With `?index=N` it answers `404` when capture `N` was already replaced by a newer one; only the newest JPEG is kept in memory.
* **`GET /api/timelapse`**: `{ running, frames, intervalMs, startedAt, nextShotAt, shot, late, failed, now, error?, finished? }` (camera epoch milliseconds; `finished` is `completed`, `stopped` or `error`).
* **`POST /api/timelapse`** `{"action":"start","frames":250,"intervalMs":28800}`: starts the camera-side scheduler (interval at least 1000 ms). Shot `i` is due at `startedAt + (i-1) * intervalMs` and is taken like the shutter key; the scheduler waits for `StoreImageComplete` (up to 30 s) before the next shot, and a shot that fires after its time counts as `late` without shifting the schedule. `{"action":"stop"}` stops after the current shot. Closing the app stops it too.
* **`GET /api/photos/download?path=<absolutePath>`**: Streams a specific SD card file (JPG or ARW). Paths outside the external storage are refused with `403` (this used to serve any file the app could read).
* **`GET /api/photos/last-shot`**: The files of the newest shot on the card (highest file name in the highest `DCIM` folder, plus files with the same base name), as `{ ok, files: [{ name, path, size }] }`.
* **`GET /api/log`**: Returns plain-text crash/debug logs from the camera.

---

## Debug Console (port 8081)

`DebugServer` runs [BeanShell](https://github.com/beanshell/beanshell) 2.0b6 scripts (Java syntax, loosely typed) inside the app, so camera behaviour can be explored without rebuilding the APK. Every request except `GET /` needs the debug key, as header `X-Debug-Key` or parameter `key`. The key is read at build time from `camera-app/debug-key.txt` (gitignored, never commit it); without that file the app creates a random key once, keeps it in its private preferences and shows it after the address in the Wi-Fi status line on the camera screen. **Anyone with the key can run arbitrary code as the app**; keep the camera on a trusted network.

* **`POST /eval[?thread=worker|main][&timeout=ms][&reset=1]`**, body = script. Runs on a worker thread by default (timeout 10 s, max 300 s); `thread=main` runs the whole script on the main thread. Variables persist between calls until `reset=1`. Redefining a scripted method keeps the first definition (a BeanShell 2.0b6 quirk), so send `reset=1` with scripts that define methods. Returns `{ ok, ms, result, resultClass, output, error }`; `print(x)` writes to `output`.
* **`GET /logcat[?lines=500]`**: The last lines of `logcat -d -v time` (`READ_LOGS` permission).
* **`POST /ota[?md5=hex]`**, body = SPK (the APK packed by Sony-PMCA-RE; `scripts/ota.sh` does it all). Stores it as `/data/local/tmp/webcontrol-ota.1.spk`, checks the `1spk` header and the MD5, answers `{ ok, bytes, md5, message }` and then starts the camera's own installer (`com.sony.scalar.dlsys.scalarainstaller/.PackageInstallerActivity`, the same one a USB install ends in). The app closes during the install; start it again from the application list. The installer only accepts a path ending in `.1.spk` and deletes the file afterwards.

Bound variables: `activity` (`MacroServerActivity`), `cam` (`CameraEx`), `normal` (`android.hardware.Camera`), `hub` (`CameraEventHub`), `goal` (`CameraGoalController`) and `dbg`:

* `dbg.main("code")` evaluates code on the main thread (5 s timeout), where camera calls belong. Never wait on the main thread for a callback that the main thread delivers.
* `dbg.proxy(Iface.class, this)` turns a scripted object into an interface implementation (`java.lang.reflect.Proxy`; class generation does not work on Dalvik, so anonymous classes do not).
* `dbg.sleep(ms)`, `dbg.now()`, `dbg.frameSize()` (size of the newest live view JPEG, a rough sharpness signal).

Example (`scripts/cam-eval.sh`):

```bash
CAM=10.10.30.104 KEY=<key> scripts/cam-eval.sh - <<'BSH'
cb() { onAutoFocus(ok, c) { print("AF " + ok + " at " + dbg.now()); } return this; }
dbg.main("normal.autoFocus((Camera.AutoFocusCallback) dbg.proxy(Camera.AutoFocusCallback.class, cb()))");
dbg.sleep(1500);
dbg.frameSize();
BSH
```
