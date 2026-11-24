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
 * Continuous autofocus (the body's AF-C) and face detection.
 *
 * Measured on the ILCE-7 (FW 3.20) through the debug console:
 * - AF-C is focus-mode "auto" plus af-mode "af-c", then Camera.autoFocus(), which acts like a
 *   held half-press: the body keeps refocusing on its own (AutoFocusStart/AutoFocusDone events,
 *   status 4 = continuous, 1 = locked, 2 = cannot lock, 0 = cleared) until cancelAutoFocus().
 *   A shutter release during AF-C waits for focus, and AF keeps running after the shot.
 * - focus-area "wide" is listed but silently refused; "multi" is the menu's Wide area.
 * - Face detection: face-detection-mode "auto" plus startFaceDetection(n) calls the listener
 *   about 6 times a second; FaceInfo.rect is in -1000..1000 over the whole live view frame.
 *   score, eyes and smile are not filled in. With face detection on, the body's AF prefers
 *   faces. There is no tracking (lock-on AF) API on this firmware.
 *
 * Leaving AF-C switches to manual focus where AF-C left the lens. The focus offset (knob) then
 * needs a new single AF first: CameraEx.shiftFocusPosition blocked forever once the AF base had
 * been invalidated, so every AF-C start calls CameraGoalController.invalidateAfBase().
 */
public final class AfModeController {

    public static final String AREA_WIDE = "wide";
    public static final String AREA_SPOT = "spot";

    private final MacroServerActivity m_activity;

    // Guarded by this.
    private boolean m_continuous;
    private boolean m_faces;
    private String m_area = AREA_WIDE;
    private double m_spotX = 0.5;
    private double m_spotY = 0.5;
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
     * After the camera was opened: adopts face detection when the body still has it on (it is a
     * body setting and survives the app), and starts in single AF.
     */
    public void onCameraOpened() {
        synchronized (this) {
            m_continuous = false;
            m_restoreAfS = false;
            m_area = AREA_WIDE;
            m_faces = false;
        }
        try {
            m_activity.runOnMainSync(new Callable<Void>() {
                @Override
                public Void call() {
                    CameraEx cam = m_activity.getCameraEx();
                    if (cam == null) return null;
                    String mode = cam.getNormalCamera().getParameters().get("face-detection-mode");
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
     * {continuous?, faces?, area? ("wide" | "spot"), x?, y?}: missing fields keep their value.
     * x and y (0..1 of the unrotated live view) select the spot and imply area "spot".
     */
    public JSONObject setAfMode(final JSONObject want) throws Exception {
        final boolean wantFaces;
        final boolean wantContinuous;
        final boolean restart;
        final String area;
        final double x;
        final double y;
        synchronized (this) {
            wantFaces = want.has("faces") ? want.getBoolean("faces") : m_faces;
            wantContinuous = want.has("continuous") ? want.getBoolean("continuous") : m_continuous;
            boolean hasPoint = want.has("x") && want.has("y");
            String a = hasPoint ? AREA_SPOT : want.optString("area", m_area);
            if (!AREA_WIDE.equals(a) && !AREA_SPOT.equals(a)) {
                throw new IllegalArgumentException("area must be \"wide\" or \"spot\", got " + a);
            }
            area = a;
            x = hasPoint ? clamp01(want.getDouble("x")) : m_spotX;
            y = hasPoint ? clamp01(want.getDouble("y")) : m_spotY;
            restart = wantContinuous && (!m_continuous || wantFaces != m_faces || !area.equals(m_area) || hasPoint);
        }

        CameraGoalController goal = m_activity.getGoalController();
        if (restart) {
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
                        startContinuous(cam, area, x, y);
                    } else if (!wantContinuous && continuous) {
                        stopContinuous(cam);
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

    // --- Main thread ---

    private void startContinuous(CameraEx cam, String area, double x, double y) {
        Camera normal = cam.getNormalCamera();
        try {
            cam.stopPreviewMagnification();
        } catch (Throwable ignored) {
        }
        Camera.Parameters p = cam.createEmptyParameters();
        CameraEx.ParametersModifier m = cam.createParametersModifier(p);
        p.setFocusMode(Camera.Parameters.FOCUS_MODE_AUTO);
        m.setAutoFocusMode(CameraEx.ParametersModifier.AUTO_FOCUS_MODE_AF_C);
        if (AREA_SPOT.equals(area)) {
            int[] pt = CameraGoalController.flexSpotPoint(cam, x, y);
            m.setFocusAreaMode(CameraEx.ParametersModifier.FOCUS_AREA_MODE_FLEX_SPOT);
            m.setFocusPoint(pt[0], pt[1]);
        } else {
            m.setFocusAreaMode(CameraEx.ParametersModifier.FOCUS_AREA_MODE_MULTI);
        }
        normal.setParameters(p);
        normal.autoFocus(m_noopAf);
        synchronized (this) {
            m_continuous = true;
            m_restoreAfS = true;
            m_area = area;
            m_spotX = x;
            m_spotY = y;
        }
        Logger.info("AF-C on, area " + area + (AREA_SPOT.equals(area) ? String.format(Locale.US, " %.2f,%.2f", x, y) : ""));
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
            m.setFocusAreaMode(CameraEx.ParametersModifier.FOCUS_AREA_MODE_FLEX_SPOT);
        }
        p.setFocusMode(CameraEx.ParametersModifier.FOCUS_MODE_MANUAL);
        normal.setParameters(p);
        Logger.info("AF-C off");
        updateLabel();
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
        if (AREA_SPOT.equals(m_area)) {
            o.put("x", round3(m_spotX));
            o.put("y", round3(m_spotY));
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
