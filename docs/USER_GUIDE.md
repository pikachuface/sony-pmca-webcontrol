# WebControl A7 — User Guide (`USER_GUIDE.md`)

This guide covers camera compatibility, flashing the `.apk` to your Sony camera, connecting over Wi-Fi, and using the web control interface.

---

## 1. Compatibility & Hardware Requirements

### Supported Camera Bodies
* **Full Support** (`ScalarProperties.PROP_VERSION_PLATFORM >= 2.3` — Live View, remote MF stepping, and exposure control):
  * **APS-C E-mount**: `ILCE-5100` (a5100), `ILCE-6000` (a6000), `ILCE-6300` (a6300), `ILCE-6500` (a6500)
  * **Full-Frame E-mount**: `ILCE-7M2` (a7 II), `ILCE-7RM2` (a7R II), `ILCE-7SM2` (a7S II), and `ILCE-7` / `ILCE-7R` / `ILCE-7S` updated to the latest firmware
  * **Fixed-Lens Cyber-shot**: `DSC-RX100M3` (RX100 III), `DSC-RX100M4` (RX100 IV), `DSC-RX100M5` (RX100 V), `DSC-RX10M2` (RX10 II), `DSC-RX10M3` (RX10 III), `DSC-RX1RM2` (RX1R II)
* **Partial Support** (`PROP_VERSION_PLATFORM < 2.3` — Live View, exposure, and capture work; motorized focus drive is unavailable in firmware):
  * `NEX-5R`, `NEX-5T`, `NEX-6`, `DSC-RX100M2`
* **Unsupported**:
  * Post-2018 Sony bodies that removed the PlayMemories Android subsystem (`a6100`, `a6400`, `a6600`, `a6700`, `ZV-E10`, `a7 III`, `a7 IV`, etc.).

> **ILCE-7 (this fork's target):** the list above is upstream's. On an `ILCE-7` with firmware 3.20
> (`version.platform` `2.3`) the firmware ignores `startOneShotFocusDrive`: `getMaxFocusDriveSpeed()`
> is `0` and no `FocusDrive` events arrive, with Sony and third-party lenses alike. Absolute focus
> positioning is therefore impossible on this body. This fork's Focus knob uses
> `shiftFocusPosition` instead, which does move focus; see section 4.

### Lens, Power & Storage Notes
* **AF Lens Requirement**: Software focus control sends electronic drive commands to the lens focus motor. **An E-mount lens with electronic contacts and an AF motor is required** (including standard AF lenses mounted on electronic AF macro extension tubes). Purely mechanical manual lenses (e.g., Laowa 65mm f/2.8 2X) cannot be focused electronically, though Live View, exposure adjustments, and shutter release still work.
* **Power Management**: The app disables auto power-off (`setAutoPowerOffMode(false)`) while active so the camera does not sleep mid-session. Using an NP-FW50 USB dummy battery is recommended for long studio sessions.
* **Storage**: Full-resolution `.JPG` and `.ARW` files are written to the camera's SD card and can be browsed on demand or auto-saved over Wi-Fi.

---

## 2. Flashing the APK to Your Camera

> **Note:** Sony Alpha cameras do **not** expose standard Android `adb` debugging. Do not use `adb install` — flashing goes through USB MTP mode.

First, download `sony-pmca-webcontrol-debug-1.0.0.apk` from **GitHub Releases** (or build it yourself — see [DEVELOPER_GUIDE.md](./DEVELOPER_GUIDE.md)), connect the camera via USB (MTP / Mass Storage mode), and power it on.

### Method A: Desktop GUI (Recommended) — PMCA-RE RELOADED
If you don't want to set up Python dependencies or USB drivers manually, use **[PMCA-RE RELOADED](https://github.com/masterflai/pmca-re-reloaded)** (cross-platform Rust desktop app for Windows, macOS, and Linux):
1. Download and launch PMCA-RE RELOADED from its [GitHub Releases](https://github.com/masterflai/pmca-re-reloaded/releases).
2. Connect your camera over USB and select `sony-pmca-webcontrol-debug-1.0.0.apk` to install.

### Method B: Command Line — `Sony-PMCA-RE` (`pmca-console.py`)
1. **Get `Sony-PMCA-RE`**:
   * `tools/` is not bundled in this repository. Either download a prebuilt binary from [Sony-PMCA-RE Releases](https://github.com/ma1co/Sony-PMCA-RE/releases), or clone it and set up a Python virtual environment:
     ```bash
     git clone https://github.com/ma1co/Sony-PMCA-RE.git tools/Sony-PMCA-RE
     python3 -m venv .venv
     .venv/bin/pip install -r tools/Sony-PMCA-RE/requirements.txt
     ```
2. **Linux desktop note (`USBError: [Errno 16] Resource busy`)**:
   Desktop environments (GNOME/GVFS) automatically mount MTP devices under `gphoto2://`, preventing `libusb` from claiming the interface. Unmount it first:
   ```bash
   gio mount -l | grep -i gphoto2
   gio mount -u gphoto2://Sony_ILCE-6000_.../
   ```
3. **Install the APK**:
   ```bash
   .venv/bin/python tools/Sony-PMCA-RE/pmca-console.py install -f camera-app/app/build/outputs/apk/sony-pmca-webcontrol-debug-1.0.0.apk
   ```
   Wait until `Task completed successfully` appears, then disconnect the USB cable.

   `Communication error 100: Error completed` at `Installing 0%` means the camera already has an app
   with the same package id signed by a different key (for example a build from another machine of a
   fork that does not commit its debug key). Delete that app on the camera first, or install a build
   signed with the same key.

---

## 3. Launching on the Camera

1. Make sure your camera has a saved Wi-Fi network configured (under camera **Network → Access Point Set.**).
2. On the camera: **Menu → Application → Application List → WebControl A7** (upstream's app is listed as *PMCA WebControl*).
3. Wait for the camera to join your Wi-Fi router. The LAN IP address and port (for example, `http://192.168.0.250:8080`) appear at the bottom of the camera screen. Press **UP** or **OK** on the camera to toggle the on-screen HUD overlay.

---

## 4. Using the Web Control UI

![Sony PMCA WebControl Web UI](./screenshot.png)

You can control the camera in two ways:

### Option A: Full React Web Client (`web-client/`)
Open the prebuilt single-file `index.html` (or run `npm run dev` in `web-client/` for HTTPS local development, which is required by browsers for `showDirectoryPicker` folder auto-save) and connect to your camera's IP (or disconnect/switch URLs in the top bar):
* **LiveView**: Canvas-based MJPEG stream (with pause/resume, 90° left/right rotation `↺ / ↻`, and a toggle to `/api/liveview.jpg` single-frame polling) featuring client-side **Focus Peaking**, **Rule-of-Thirds Grid**, **Luma Histogram**, click-to-**Focus** (touch AF lock), and a **full screen** button (`⛶`; `Esc` or `✕` to exit). Automatically pauses and notifies the camera to release the stream slot when you switch browser tabs or minimize the window.
* **Exposure, White Balance & Zoom**: Real-time aperture and shutter speed steppers with per-metric **Auto** toggles, ISO selector, EV compensation (with `Reset` and automatic disable in full manual mode), **White Balance** presets / Color Temp (`K`) / `A/B` & `G/M` shifts, live focal length (`mm`) with tap/hold power zoom controls, and remote shutter release.
* **Focus**: a **[−] knob [+]** for relative manual focus. Turn the knob with the scroll wheel, a vertical drag, or the arrow keys when it has keyboard focus; the `−`/`+` buttons move one detent. Each detent moves focus by **Step size** (default `4`, up to `64`); hold **Shift** to move by `1`. The badge shows the net shift since **Reset Δ**, because the camera reports no absolute focus position. Moves go through `highlevel.shiftFocus` and need an AF lens.
* **Save / Auto-Save**: Available in all modes. Toggle **Auto** to automatically save newly captured photos (`capture_YYYYMMDD_HHMMSS.jpg`) to your **browser machine's local folder** (via File System Access API `showDirectoryPicker` on HTTPS/`localhost`, or standard browser download fallback over plain HTTP), plus **Download Latest** and **View Latest** buttons.
* **Photo Browser & Events**: Browse SD card `DCIM` folders, preview photos, download `.JPG` / `.ARW` files, and inspect live SSE camera events.
* **RPC Inspector**: Interactive `/api/describe` explorer and `/api/call` tester.

> **Auto-Save Browser Context Note:**
> * Opening the single-file `index.html` via `file://` or directly from the camera (`http://<camera-ip>:8080`) works for LiveView, exposure/WB, focus, photo browsing, and **Auto-Save** — browsers simply fall back to standard browser downloads into your default Downloads folder instead of `showDirectoryPicker`.
> * To save silently into a chosen local folder via `showDirectoryPicker`, open the UI from a secure context: either run `host-server/server.py` (HTTPS over LAN), run `cd web-client && npm run dev` (local HTTPS + `/api` proxy), or serve `dist/index.html` on `http://localhost`.

### Option B: Host Companion Backend (`host-server/server.py`, Recommended for Local Folder Auto-Save)
Run the zero-dependency Python 3 companion server on your computer to serve the web UI over HTTPS, proxy `/api/*` to the camera, and unlock `showDirectoryPicker` local-folder **Auto-Save** over your LAN:

1. **Prepare the web UI** (pick one):
   * **Prebuilt Release (no Node.js required)**: Download `index.html` from GitHub Releases and pass `--web-dist /path/to/index.html`.
   * **From source**: Run `cd web-client && npm ci && npm run build` once to generate `web-client/dist/index.html`.
2. **Start the server**:
```bash
python3 host-server/server.py \
  --camera http://<camera-ip>:8080 \
  --web-dist /path/to/index.html
```
Then open `https://localhost:8000` (or `https://<host-ip>:8000` over LAN, accepting the self-signed certificate) in your browser. HTTPS is always enabled so `showDirectoryPicker` Auto-Save works across your LAN.

### Option C: Built-in In-Camera UI
Opening `http://<camera-ip>:8080` directly in any modern browser on your LAN serves the pre-compressed, camera-embedded React UI (`assets/index.html.gzip`, served with `Content-Encoding: gzip`), providing LiveView, Focus Peaking, Exposure/WB/Zoom, the Focus knob, Save/Auto-Save (via browser downloads), Photos, Events, and RPC Inspector without running a separate host server.
