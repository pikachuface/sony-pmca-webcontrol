package com.sony.pmca.webcontrol;

import android.graphics.Rect;
import android.hardware.Camera;

import com.github.ma1co.pmcademo.app.Logger;
import com.sony.scalar.hardware.CameraEx;
import com.sony.scalar.meta.FaceInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Locale;
import java.util.concurrent.Callable;

/**
 * Focus area (Wide, Center or a flexible spot of three sizes), continuous autofocus (the body's
 * AF-C) and face detection.
 *
 * Measured on the ILCE-7 (FW 3.20) through the debug console:
 * - AF-C is focus-mode "auto" plus af-mode "af-c", then Camera.autoFocus(), which acts like a
 *   held half-press: the body keeps refocusing on its own (AutoFocusStart/AutoFocusDone events,
 *   status 4 = continuous, 1 = locked, 2 = cannot lock, 0 = cleared) until cancelAutoFocus().
 *   A shutter release during AF-C waits for focus, and AF keeps running after the shot.
 * - Focus areas: "multi" is the menu's Wide area ("wide" is listed but silently refused,
 *   "local" and "spot" too), "center" and "flex-spot" with focus-area-flexible-spot-size small,
 *   midium (Sony's spelling) or large.
 * - Coordinates are -1000..1000 over the whole live view frame, as for faces. getFocusAreaInfos
 *   reports for flex-spot the AF area (-786..787, -826..827), the range of the spot centre
 *   (-855..856, -826..827, wider than the AF area, so the AF area is not the frame) and the
 *   spot size (S 115x155, M 209x249, L 303x342); for center the rectangle (-154,-161)-(149,180).
 * - Face detection: face-detection-mode "auto" plus startFaceDetection(n) calls the listener
 *   about 6 times a second; FaceInfo.rect is in the same coordinates. score, eyes and smile are
 *   not filled in. With face detection on, the body's AF prefers faces. There is no tracking
 *   (lock-on AF) API on this firmware.
 *
 * Leaving AF-C switches to manual focus where AF-C left the lens. The focus offset (knob) then
 * needs a new single AF first: CameraEx.shiftFocusPosition blocked forever once the AF base had
 * been invalidated, so every AF-C start calls CameraGoalController.invalidateAfBase().
 */
public final class AfModeController {

    public static final String AREA_WIDE = "wide";
    public static final String AREA_CENTER = "center";
    public static final String AREA_SPOT = "spot";
    public static final String SIZE_SMALL = "small";
    public static final String SIZE_MEDIUM = "medium";
    public static final String SIZE_LARGE = "large";

    /** ILCE-7 values, used when the body reports no focus area infos. */
    private static final Rect WIDE_FALLBACK = new Rect(-786, -826, 787, 827);
    private static final Rect CENTER_FALLBACK = new Rect(-154, -161, 149, 180);
    private static final Rect SPOT_RANGE_FALLBACK = new Rect(-855, -826, 856, 827);

    private final MacroServerActivity m_activity;

    // Guarded by this.
    private boolean m_continuous;
    private boolean m_faces;
    private String m_area = AREA_SPOT;
    private String m_spotSize = SIZE_LARGE;
    /** Spot centre, 0..1 of the live view, as the body clamps it. */
    private double m_spotX = 0.5;
    private double m_spotY = 0.5;
    /** Focus window of the current area, 0..1 of the live view: {x, y, w, h}. */
    private double[] m_window;
    /** True once this app switched the body to AF-C, so leaving restores AF-S. */
    private boolean m_restoreAfS;

    // Main thread only (face callbacks).
    private String m_lastFaceKey = "";
    private int m_faceCount;

    private final CameraEx.FaceDetectionListener m_faceListener = new CameraEx.FaceDetectionListener() {
        @Override
        public void onFaceDetected(FaceInfo[] faces, CameraEx cameraEx) {
            publishFaces(faces);
        }
    };

    private final Camera.AutoFocusCallback m_noopAf = new Camera.AutoFocusCallback() {
        @Override
        public void onAutoFocus(boolean success, Camera camera) {
            // AF-C reports through the AutoFocusDone listener; this callback only fires once.
        }
    };

    public AfModeController(MacroServerActivity activity) {
        m_activity = activity;
    }

    public synchronized boolean isContinuous() {
        return m_continuous;
    }

    /**
     * After the camera was opened: takes over the body's focus area, spot size and position and
     * its face detection (body settings that survive the app), and starts in single AF.
     */
    public void onCameraOpened() {
        synchronized (this) {
            m_continuous = false;
            m_restoreAfS = false;
            m_faces = false;
        }
        try {
            m_activity.runOnMainSync(new Callable<Void>() {
                @Override
                public Void call() {
                    CameraEx cam = m_activity.getCameraEx();
                    if (cam == null) return null;
                    Camera.Parameters p = cam.getNormalCamera().getParameters();
                    String area = fromBodyArea(p.get("focus-area-type"));
                    String size = fromBodySize(p.get("focus-area-flexible-spot-size"));
                    double x = 0.5;
                    double y = 0.5;
                    try {
                        x = (Integer.parseInt(p.get("focus-point-x")) + 1000) / 2000.0;
                        y = (Integer.parseInt(p.get("focus-point-y")) + 1000) / 2000.0;
                    } catch (Throwable ignored) {
                    }
                    updateWindow(cam, area, size, clamp01(x), clamp01(y));
                    String mode = p.get("face-detection-mode");
                    if (mode != null && !CameraEx.ParametersModifier.FACE_DETECTION_MODE_OFF.equals(mode)) {
                        applyFaces(cam, true);
                    }
                    return null;
                }
            }, MacroServerActivity.MAIN_THREAD_TIMEOUT_MS);
        } catch (Throwable t) {
            Logger.error("AF mode init: " + t);
        }
        publish();
    }

    /** Before the camera is released: stops AF-C and face callbacks. Runs on the main thread. */
    public void onCameraClosing(CameraEx cam) {
        boolean continuous;
        boolean faces;
        synchronized (this) {
            continuous = m_continuous;
            faces = m_faces;
        }
        if (cam == null) return;
        try {
            if (continuous) {
                stopContinuous(cam);
            }
            if (faces) {
                // Face detection stays on in the body (like its menu setting); only the callback stops.
                cam.stopFaceDetection();
                cam.setFaceDetectionListener(null);
            }
        } catch (Throwable t) {
            Logger.error("AF mode close: " + t);
        }
    }

    public JSONObject getState() throws Exception {
        synchronized (this) {
            return stateJson();
        }
    }

    /**
     * {continuous?, faces?, area? ("wide" | "center" | "spot"), spotSize? ("small" | "medium" |
     * "large"), x?, y?, refocus?}: missing fields keep their value. x and y (0..1 of the
     * unrotated live view) move the spot and imply area "spot". refocus restarts a running AF-C.
     */
    public JSONObject setAfMode(final JSONObject want) throws Exception {
        final boolean wantFaces;
        final boolean wantContinuous;
        final boolean restart;
        final boolean writeArea;
        final String area;
        final String size;
        final double x;
        final double y;
        synchronized (this) {
            wantFaces = want.has("faces") ? want.getBoolean("faces") : m_faces;
            wantContinuous = want.has("continuous") ? want.getBoolean("continuous") : m_continuous;
            boolean hasPoint = want.has("x") && want.has("y");
            area = hasPoint ? AREA_SPOT : want.optString("area", m_area);
            if (!AREA_WIDE.equals(area) && !AREA_CENTER.equals(area) && !AREA_SPOT.equals(area)) {
                throw new IllegalArgumentException("area must be \"wide\", \"center\" or \"spot\", got " + area);
            }
            size = want.optString("spotSize", m_spotSize);
            if (!SIZE_SMALL.equals(size) && !SIZE_MEDIUM.equals(size) && !SIZE_LARGE.equals(size)) {
                throw new IllegalArgumentException("spotSize must be \"small\", \"medium\" or \"large\", got " + size);
            }
            x = hasPoint ? clamp01(want.getDouble("x")) : m_spotX;
            y = hasPoint ? clamp01(want.getDouble("y")) : m_spotY;
            boolean areaChanged = !area.equals(m_area) || !size.equals(m_spotSize) || hasPoint;
            restart = wantContinuous && (!m_continuous || wantFaces != m_faces || areaChanged
                    || want.optBoolean("refocus", false));
            writeArea = !wantContinuous && areaChanged;
        }

        CameraGoalController goal = m_activity.getGoalController();
        if (restart || writeArea) {
            // Ends a single AF that is still running (its cleanup would switch to manual focus).
            goal.supersedeFocus();
        }
        synchronized (goal.focusOpLock()) {
            m_activity.runOnMainSync(new Callable<Void>() {
                @Override
                public Void call() throws Exception {
                    CameraEx cam = m_activity.getCameraEx();
                    if (cam == null) {
                        throw new IllegalStateException("Camera not initialized");
                    }
                    boolean faces;
                    boolean continuous;
                    synchronized (AfModeController.this) {
                        faces = m_faces;
                        continuous = m_continuous;
                    }
                    if (restart && continuous) {
                        try {
                            cam.getNormalCamera().cancelAutoFocus();
                        } catch (Throwable ignored) {
                        }
                    }
                    if (wantFaces != faces) {
                        applyFaces(cam, wantFaces);
                    }
                    if (restart) {
                        startContinuous(cam, area, size, x, y);
                    } else if (!wantContinuous && continuous) {
                        stopContinuous(cam);
                    }
                    if (writeArea) {
                        Camera.Parameters p = cam.createEmptyParameters();
                        writeArea(cam, p, cam.createParametersModifier(p), area, size, x, y);
                        cam.getNormalCamera().setParameters(p);
                        updateWindow(cam, area, size, x, y);
                    }
                    return null;
                }
            }, MacroServerActivity.MAIN_THREAD_TIMEOUT_MS);
            if (restart) {
                goal.invalidateAfBase();
            }
        }
        publish();
        synchronized (this) {
            JSONObject res = stateJson();
            res.put("focused", true);
            return res;
        }
    }

    /**
     * A click on the live view while AF-C runs: AF-C goes on in a spot at the click. In the Wide
     * or Center area the area switches to Spot, since a click means "focus here".
     */
    public JSONObject continuousClick(double nx, double ny) throws Exception {
        JSONObject want = new JSONObject();
        want.put("x", nx);
        want.put("y", ny);
        return setAfMode(want);
    }

    /**
     * Single AF setup on the main thread: focus-mode auto, AF-S and a spot at (nx, ny); the
     * Wide and Center areas switch to Spot, since a click means "focus here". Returns the focus
     * point written, in -1000..1000.
     */
    int[] configureSingleAf(CameraEx cam, double nx, double ny) {
        String area = AREA_SPOT;
        String size;
        double x = clamp01(nx);
        double y = clamp01(ny);
        synchronized (this) {
            size = m_spotSize;
        }
        Camera.Parameters p = cam.createEmptyParameters();
        CameraEx.ParametersModifier m = cam.createParametersModifier(p);
        p.setFocusMode(Camera.Parameters.FOCUS_MODE_AUTO);
        m.setAutoFocusMode(CameraEx.ParametersModifier.AUTO_FOCUS_MODE_AF_S);
        int[] pt = writeArea(cam, p, m, area, size, x, y);
        cam.getNormalCamera().setParameters(p);
        updateWindow(cam, area, size, x, y);
        publish();
        return pt;
    }

    // --- Main thread ---

    private void startContinuous(CameraEx cam, String area, String size, double x, double y) {
        Camera normal = cam.getNormalCamera();
        try {
            cam.stopPreviewMagnification();
        } catch (Throwable ignored) {
        }
        Camera.Parameters p = cam.createEmptyParameters();
        CameraEx.ParametersModifier m = cam.createParametersModifier(p);
        p.setFocusMode(Camera.Parameters.FOCUS_MODE_AUTO);
        m.setAutoFocusMode(CameraEx.ParametersModifier.AUTO_FOCUS_MODE_AF_C);
        writeArea(cam, p, m, area, size, x, y);
        normal.setParameters(p);
        updateWindow(cam, area, size, x, y);
        normal.autoFocus(m_noopAf);
        synchronized (this) {
            m_continuous = true;
            m_restoreAfS = true;
        }
        Logger.info("AF-C on, area " + area + (AREA_SPOT.equals(area) ? String.format(Locale.US, " %s %.2f,%.2f", size, x, y) : ""));
        updateLabel();
    }

    private void stopContinuous(CameraEx cam) {
        Camera normal = cam.getNormalCamera();
        try {
            normal.cancelAutoFocus();
        } catch (Throwable ignored) {
        }
        boolean restore;
        synchronized (this) {
            restore = m_restoreAfS;
            m_continuous = false;
            m_restoreAfS = false;
        }
        Camera.Parameters p = cam.createEmptyParameters();
        CameraEx.ParametersModifier m = cam.createParametersModifier(p);
        if (restore) {
            m.setAutoFocusMode(CameraEx.ParametersModifier.AUTO_FOCUS_MODE_AF_S);
        }
        p.setFocusMode(CameraEx.ParametersModifier.FOCUS_MODE_MANUAL);
        normal.setParameters(p);
        Logger.info("AF-C off");
        updateLabel();
    }

    /** Puts area, spot size and spot position into a partial parameter write. */
    private static int[] writeArea(CameraEx cam, Camera.Parameters p, CameraEx.ParametersModifier m,
                                   String area, String size, double x, double y) {
        if (AREA_CENTER.equals(area)) {
            m.setFocusAreaMode(CameraEx.ParametersModifier.FOCUS_AREA_MODE_CENTER);
            return new int[]{0, 0};
        }
        if (AREA_WIDE.equals(area)) {
            m.setFocusAreaMode(CameraEx.ParametersModifier.FOCUS_AREA_MODE_MULTI);
            return new int[]{0, 0};
        }
        int[] pt = spotPoint(focusAreaRects(cam, CameraEx.ParametersModifier.FOCUS_AREA_MODE_FLEX_SPOT), x, y);
        m.setFocusAreaMode(CameraEx.ParametersModifier.FOCUS_AREA_MODE_FLEX_SPOT);
        m.setFocusAreaFlexibleSpotSize(bodySize(size));
        m.setFocusPoint(pt[0], pt[1]);
        return pt;
    }

    /** Stores area and size and computes the focus window from what the body reports. */
    private void updateWindow(CameraEx cam, String area, String size, double x, double y) {
        double[] window;
        double sx = x;
        double sy = y;
        if (AREA_SPOT.equals(area)) {
            Rect[] rects = focusAreaRects(cam, CameraEx.ParametersModifier.FOCUS_AREA_MODE_FLEX_SPOT);
            int[] pt = spotPoint(rects, x, y);
            // Spot sizes as getFocusAreaInfos reports them; not read back, because right after a
            // size change it sometimes still reported the previous size.
            int w;
            int h;
            if (SIZE_SMALL.equals(size)) {
                w = 115;
                h = 155;
            } else if (SIZE_MEDIUM.equals(size)) {
                w = 209;
                h = 249;
            } else {
                w = 303;
                h = 342;
            }
            sx = (pt[0] + 1000) / 2000.0;
            sy = (pt[1] + 1000) / 2000.0;
            window = new double[]{(pt[0] - w / 2.0 + 1000) / 2000.0, (pt[1] - h / 2.0 + 1000) / 2000.0, w / 2000.0, h / 2000.0};
        } else if (AREA_CENTER.equals(area)) {
            Rect[] rects = focusAreaRects(cam, CameraEx.ParametersModifier.FOCUS_AREA_MODE_CENTER);
            window = toWindow(rects != null && rects.length > 1 && rects[1] != null ? rects[1] : CENTER_FALLBACK);
        } else {
            Rect[] rects = focusAreaRects(cam, CameraEx.ParametersModifier.FOCUS_AREA_MODE_MULTI);
            window = toWindow(rects != null && rects.length > 0 && rects[0] != null ? rects[0] : WIDE_FALLBACK);
        }
        synchronized (this) {
            m_area = area;
            m_spotSize = size;
            m_spotX = sx;
            m_spotY = sy;
            m_window = window;
        }
    }

    private void applyFaces(CameraEx cam, boolean on) {
        Camera normal = cam.getNormalCamera();
        Camera.Parameters p = cam.createEmptyParameters();
        CameraEx.ParametersModifier m = cam.createParametersModifier(p);
        m.setFaceDetectionMode(on ? CameraEx.ParametersModifier.FACE_DETECTION_MODE_AUTO
                : CameraEx.ParametersModifier.FACE_DETECTION_MODE_OFF);
        normal.setParameters(p);
        if (on) {
            int max = 8;
            try {
                max = Math.max(1, cam.createParametersModifier(normal.getParameters()).getMaxNumDetectedFaces());
            } catch (Throwable ignored) {
            }
            cam.setFaceDetectionListener(m_faceListener);
            cam.startFaceDetection(max);
        } else {
            try {
                cam.stopFaceDetection();
            } catch (Throwable ignored) {
            }
            cam.setFaceDetectionListener(null);
            publishFaces(null);
        }
        synchronized (this) {
            m_faces = on;
        }
        updateLabel();
    }

    /** State "faces" and a Faces event, only when the boxes changed (rounded to 1% of the frame). */
    private void publishFaces(FaceInfo[] faces) {
        try {
            JSONArray arr = new JSONArray();
            StringBuilder key = new StringBuilder();
            if (faces != null) {
                for (FaceInfo f : faces) {
                    if (f == null || f.rect == null) continue;
                    Rect r = f.rect;
                    double l = norm(r.left);
                    double t = norm(r.top);
                    double w = norm(r.right) - l;
                    double h = norm(r.bottom) - t;
                    if (w <= 0 || h <= 0) continue;
                    JSONObject o = new JSONObject();
                    o.put("x", round3(l));
                    o.put("y", round3(t));
                    o.put("w", round3(w));
                    o.put("h", round3(h));
                    o.put("id", f.id);
                    arr.put(o);
                    key.append(Math.round(l * 100)).append(',').append(Math.round(t * 100)).append(',')
                            .append(Math.round(w * 100)).append(',').append(Math.round(h * 100)).append(';');
                }
            }
            String k = key.toString();
            if (k.equals(m_lastFaceKey)) return;
            m_lastFaceKey = k;
            JSONObject data = new JSONObject();
            data.put("faces", arr);
            CameraEventHub hub = m_activity.getEventHub();
            if (hub != null) {
                hub.setState("faces", data);
                hub.emit("Faces", data);
            }
            if (arr.length() != m_faceCount) {
                m_faceCount = arr.length();
                updateLabel();
            }
        } catch (Throwable ignored) {
        }
    }

    // --- Helpers ---

    /** The rectangles getFocusAreaInfos reports for one body area mode, or null. */
    private static Rect[] focusAreaRects(CameraEx cam, String bodyArea) {
        try {
            CameraEx.FocusAreaInfos[] infos = cam.getFocusAreaInfos(0);
            if (infos == null) return null;
            for (CameraEx.FocusAreaInfos info : infos) {
                if (info != null && bodyArea.equals(info.focusAreaMode) && info.rectInfos != null) {
                    Rect[] rects = new Rect[info.rectInfos.length];
                    for (int i = 0; i < rects.length; i++) {
                        rects[i] = info.rectInfos[i] != null ? info.rectInfos[i].rect : null;
                    }
                    return rects;
                }
            }
        } catch (Throwable ignored) {
        }
        return null;
    }

    /** Spot centre for (nx, ny) in -1000..1000, clamped to the range the body reports. */
    private static int[] spotPoint(Rect[] flexSpotRects, double nx, double ny) {
        Rect range = flexSpotRects != null && flexSpotRects.length > 1 && flexSpotRects[1] != null
                ? flexSpotRects[1] : SPOT_RANGE_FALLBACK;
        int px = (int) Math.round(-1000 + 2000 * clamp01(nx));
        int py = (int) Math.round(-1000 + 2000 * clamp01(ny));
        return new int[]{
                Math.max(range.left, Math.min(range.right, px)),
                Math.max(range.top, Math.min(range.bottom, py)),
        };
    }

    private static double[] toWindow(Rect r) {
        return new double[]{norm(r.left), norm(r.top), (r.right - r.left) / 2000.0, (r.bottom - r.top) / 2000.0};
    }

    private static String bodySize(String size) {
        return SIZE_MEDIUM.equals(size) ? "midium" : size;
    }

    private static String fromBodySize(String body) {
        if ("small".equals(body)) return SIZE_SMALL;
        if ("midium".equals(body) || "medium".equals(body)) return SIZE_MEDIUM;
        return SIZE_LARGE;
    }

    private static String fromBodyArea(String body) {
        if (CameraEx.ParametersModifier.FOCUS_AREA_MODE_CENTER.equals(body)) return AREA_CENTER;
        if (CameraEx.ParametersModifier.FOCUS_AREA_MODE_FLEX_SPOT.equals(body)) return AREA_SPOT;
        return AREA_WIDE;
    }

    private void updateLabel() {
        StringBuilder sb = new StringBuilder();
        synchronized (this) {
            if (m_continuous) sb.append("AF-C");
            if (m_faces) {
                if (sb.length() > 0) sb.append(' ');
                sb.append("Face");
                if (m_faceCount > 0) sb.append(':').append(m_faceCount);
            }
        }
        m_activity.setAfLabel(sb.toString());
    }

    private void publish() {
        try {
            JSONObject s;
            synchronized (this) {
                s = stateJson();
            }
            CameraEventHub hub = m_activity.getEventHub();
            if (hub != null) {
                hub.setState("afMode", s);
                hub.emit("AfMode", s);
            }
        } catch (Throwable ignored) {
        }
    }

    private JSONObject stateJson() throws Exception {
        JSONObject o = new JSONObject();
        o.put("continuous", m_continuous);
        o.put("faces", m_faces);
        o.put("area", m_area);
        o.put("spotSize", m_spotSize);
        o.put("x", round3(m_spotX));
        o.put("y", round3(m_spotY));
        if (m_window != null) {
            JSONObject w = new JSONObject();
            w.put("x", round3(m_window[0]));
            w.put("y", round3(m_window[1]));
            w.put("w", round3(m_window[2]));
            w.put("h", round3(m_window[3]));
            o.put("window", w);
        }
        return o;
    }

    private static double norm(int v) {
        return (Math.max(-1000, Math.min(1000, v)) + 1000) / 2000.0;
    }

    private static double round3(double v) {
        return Math.round(v * 1000) / 1000.0;
    }

    private static double clamp01(double v) {
        return Math.max(0.0, Math.min(1.0, v));
    }
}
