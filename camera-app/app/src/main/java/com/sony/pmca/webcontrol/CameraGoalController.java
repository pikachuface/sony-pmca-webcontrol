package com.sony.pmca.webcontrol;

import android.hardware.Camera;

import com.sony.scalar.hardware.CameraEx;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Event-driven, device-side closed-loop controller for camera parameters that
 * only expose relative/stepping APIs (focus, aperture, shutter speed, power zoom).
 *
 * Concurrency model:
 * - Each parameter has an independent GoalSlot, so different parameters run in parallel.
 * - Within the same parameter, a new command increments generationId (latest-wins preemption),
 *   immediately waking and aborting any in-flight older request for that parameter.
 * - Waiting happens on the calling HTTP worker thread; only individual short drive calls
 *   are dispatched to the Android main thread via runOnMainSync, so the camera UI never blocks.
 */
public class CameraGoalController {

    private static final int FOCUS_NEAR = 0;
    private static final int FOCUS_FAR = 1;
    private static final int ZOOM_TELE = 0;
    private static final int ZOOM_WIDE = 1;

    private static final class GoalSlot {
        long generation = 0;
        long updateSeq = 0;
        boolean hasValue = false;

        int v1 = 0;
        int v2 = 0;
        int min1 = 0;
        int max1 = 0;
        int minN = 0;
        int minD = 0;
        int maxN = 0;
        int maxD = 0;

        synchronized long nextGeneration() {
            generation++;
            notifyAll();
            return generation;
        }

        synchronized long getUpdateSeq() {
            return updateSeq;
        }

        synchronized boolean isCurrent(long myGen) {
            return generation == myGen;
        }

        synchronized void waitForChange(long myGen, long prevSeq, long timeoutMs) {
            long deadline = System.currentTimeMillis() + timeoutMs;
            while (generation == myGen && updateSeq == prevSeq) {
                long rem = deadline - System.currentTimeMillis();
                if (rem <= 0) break;
                try {
                    wait(rem);
                } catch (InterruptedException ignored) {
                    break;
                }
            }
        }
    }

    private final MacroServerActivity m_activity;
    private final GoalSlot m_focus = new GoalSlot();
    private final Object m_focusOpLock = new Object();
    private final GoalSlot m_aperture = new GoalSlot();
    private final GoalSlot m_shutter = new GoalSlot();
    private final GoalSlot m_zoom = new GoalSlot();

    public CameraGoalController(MacroServerActivity activity) {
        m_activity = activity;
    }

    // --- Hardware Listener Hooks ---

    public void onFocusChanged(int currentPos, int maxPos) {
        synchronized (m_focus) {
            m_focus.hasValue = true;
            m_focus.v1 = currentPos;
            m_focus.max1 = maxPos;
            m_focus.updateSeq++;
            m_focus.notifyAll();
        }
    }

    public void onApertureChanged(int currentAperture, int minAperture, int maxAperture) {
        synchronized (m_aperture) {
            m_aperture.hasValue = true;
            m_aperture.v1 = currentAperture;
            m_aperture.min1 = minAperture;
            m_aperture.max1 = maxAperture;
            m_aperture.updateSeq++;
            m_aperture.notifyAll();
        }
    }

    public void onShutterChanged(int n, int d, int minN, int minD, int maxN, int maxD) {
        synchronized (m_shutter) {
            m_shutter.hasValue = true;
            m_shutter.v1 = n;
            m_shutter.v2 = d;
            m_shutter.minN = minN;
            m_shutter.minD = minD;
            m_shutter.maxN = maxN;
            m_shutter.maxD = maxD;
            m_shutter.updateSeq++;
            m_shutter.notifyAll();
        }
    }

    public void onZoomChanged(int opticalPosition, boolean stopped) {
        synchronized (m_zoom) {
            m_zoom.hasValue = true;
            m_zoom.v1 = opticalPosition;
            m_zoom.v2 = stopped ? 1 : 0;
            m_zoom.updateSeq++;
            m_zoom.notifyAll();
        }
    }

    // --- RPC Entrypoint ---

    public JSONObject execute(String method, JSONArray args) throws Exception {
        if ("setFocusPosition".equals(method)) {
            if (args == null || args.length() < 1) {
                throw new IllegalArgumentException("setFocusPosition requires (targetPos[, tolerance])");
            }
            int target = args.getInt(0);
            int tol = args.length() >= 2 ? args.getInt(1) : 0;
            return setFocusPosition(target, Math.max(0, tol));
        }
        if ("autoFocusAt".equals(method)) {
            if (args == null || args.length() < 2) {
                throw new IllegalArgumentException("autoFocusAt requires (normX, normY)");
            }
            return autoFocusAt(args.getDouble(0), args.getDouble(1));
        }
        if ("setAperture".equals(method)) {
            if (args == null || args.length() < 1) {
                throw new IllegalArgumentException("setAperture requires (fValue100)");
            }
            return setAperture(args.getInt(0));
        }
        if ("setShutterSpeed".equals(method)) {
            if (args == null || args.length() < 2) {
                throw new IllegalArgumentException("setShutterSpeed requires (numerator, denominator)");
            }
            return setShutterSpeed(args.getInt(0), args.getInt(1));
        }
        if ("setZoomPosition".equals(method)) {
            if (args == null || args.length() < 1) {
                throw new IllegalArgumentException("setZoomPosition requires (opticalPosition[, tolerance])");
            }
            int target = args.getInt(0);
            int tol = args.length() >= 2 ? args.getInt(1) : 1;
            return setZoomPosition(target, Math.max(0, tol));
        }
        if ("shiftFocus".equals(method)) {
            if (args == null || args.length() < 1) {
                throw new IllegalArgumentException("shiftFocus requires (steps[, skipAfCheck])");
            }
            return shiftFocus(args.getInt(0), args.length() >= 2 && args.getBoolean(1));
        }
        if ("setFocusOffset".equals(method)) {
            if (args == null || args.length() < 1) {
                throw new IllegalArgumentException("setFocusOffset requires (offset[, skipAfCheck])");
            }
            return setFocusOffset(args.getInt(0), args.length() >= 2 && args.getBoolean(1));
        }
        if ("getAfMode".equals(method)) {
            return m_activity.getAfMode().getState();
        }
        if ("setAfMode".equals(method)) {
            if (args == null || args.length() < 1 || args.optJSONObject(0) == null) {
                throw new IllegalArgumentException(
                        "setAfMode requires ({continuous?, faces?, area?: \"wide\"|\"spot\", x?, y?})");
            }
            return m_activity.getAfMode().setAfMode(args.getJSONObject(0));
        }
        if ("getCaptureSettings".equals(method)) {
            return getCaptureSettings();
        }
        if ("setCaptureSettings".equals(method)) {
            if (args == null || args.length() < 1 || args.optJSONObject(0) == null) {
                throw new IllegalArgumentException(
                        "setCaptureSettings requires ({format?, jpegQuality?, imageSize?, aspect?})");
            }
            return setCaptureSettings(args.getJSONObject(0));
        }
        throw new NoSuchMethodException("Unknown highlevel method: " + method);
    }

    // --- Still Image Quality ---

    /** Reads format, JPEG quality, size and aspect (with allowed values) and publishes them. */
    public JSONObject getCaptureSettings() throws Exception {
        JSONObject s = m_activity.runOnMainSync(new Callable<JSONObject>() {
            @Override
            public JSONObject call() {
                CameraEx cam = m_activity.getCameraEx();
                if (cam == null) {
                    throw new IllegalStateException("Camera not initialized");
                }
                return CaptureSettings.toJson(cam.getNormalCamera().getParameters());
            }
        }, MacroServerActivity.MAIN_THREAD_TIMEOUT_MS);
        m_activity.publishCaptureSettings(s);
        return s;
    }

    /**
     * Writes the given quality fields in one partial parameter write and returns the settings
     * read back from the body, which is what the camera actually accepted.
     */
    private JSONObject setCaptureSettings(final JSONObject want) throws Exception {
        JSONObject s = m_activity.runOnMainSync(new Callable<JSONObject>() {
            @Override
            public JSONObject call() throws Exception {
                CameraEx cam = m_activity.getCameraEx();
                if (cam == null) {
                    throw new IllegalStateException("Camera not initialized");
                }
                Camera normal = cam.getNormalCamera();
                Camera.Parameters out = cam.createEmptyParameters();
                if (CaptureSettings.apply(normal.getParameters(), out, want) > 0) {
                    normal.setParameters(out);
                }
                return CaptureSettings.toJson(normal.getParameters());
            }
        }, MacroServerActivity.MAIN_THREAD_TIMEOUT_MS);
        m_activity.publishCaptureSettings(s);
        return s;
    }

    // --- Focus Offset From The AF Point ---

    /** Largest |offset| when the body does not report getMaxFocusShift(). */
    private static final int DEFAULT_MAX_FOCUS_SHIFT = 16;
    /** A shiftFocusPosition call normally returns in 130-220 ms on the ILCE-7. */
    private static final long FOCUS_SHIFT_TIMEOUT_MS = 2500L;

    /** Lock that serializes autofocus and focus offset calls (AfModeController takes it too). */
    Object focusOpLock() {
        return m_focusOpLock;
    }

    /** Makes a running autoFocusAt give up at its next check (within about 100 ms). */
    void supersedeFocus() {
        m_focus.nextGeneration();
    }

    /**
     * Continuous AF moved the lens away from the last single AF: offsets need a new autoFocusAt
     * before shiftFocusPosition may be called again (it blocked forever on an invalid AF base).
     */
    void invalidateAfBase() {
        m_afEstablished = false;
        synchronized (m_focusOpLock) {
            m_focusOffset = 0;
        }
        publishFocusShift();
    }

    /** Set once an autoFocusAt succeeded; see setFocusOffset. */
    private volatile boolean m_afEstablished;
    /** True while a shiftFocusPosition call has not returned (possibly blocked forever). */
    private volatile boolean m_shiftInFlight;
    /** Current offset from the last AF position, as last passed to shiftFocusPosition. */
    private int m_focusOffset;
    private int m_focusOffsetMax = DEFAULT_MAX_FOCUS_SHIFT;

    /**
     * Called after every successful autoFocusAt: the lens sits at the new AF position, so the
     * offset is 0 again. Publishes state "focusShift" and a FocusShift event.
     */
    private void onAutoFocusSucceeded() {
        m_afEstablished = true;
        int max = queryMaxFocusShift();
        synchronized (m_focusOpLock) {
            m_focusOffset = 0;
            m_focusOffsetMax = max;
        }
        publishFocusShift();
    }

    private void publishFocusShift() {
        try {
            JSONObject data = focusShiftJson();
            CameraEventHub hub = m_activity.getEventHub();
            if (hub != null) {
                hub.setState("focusShift", data);
                hub.emit("FocusShift", focusShiftJson());
            }
        } catch (Throwable ignored) {
        }
    }

    private JSONObject focusShiftJson() throws Exception {
        JSONObject o = new JSONObject();
        synchronized (m_focusOpLock) {
            o.put("ready", m_afEstablished);
            o.put("offset", m_focusOffset);
            o.put("min", -m_focusOffsetMax);
            o.put("max", m_focusOffsetMax);
        }
        return o;
    }

    /** Moves the focus offset by {@code steps}, clamped to the body's range; see setFocusOffset. */
    private JSONObject shiftFocus(int steps, boolean skipAfCheck) throws Exception {
        synchronized (m_focusOpLock) {
            return setFocusOffset(m_focusOffset + steps, skipAfCheck);
        }
    }

    /**
     * Sets focus to the last AF position plus {@code offset} steps, clamped to
     * [-getMaxFocusShift(), +getMaxFocusShift()] (±16 on the ILCE-7).
     *
     * CameraEx.shiftFocusPosition(n) is not a relative move. Measured on the ILCE-7 with the
     * FE 50mm F1.8: repeating shiftFocusPosition(16) leaves focus where the first call put it,
     * and shiftFocusPosition(8) afterwards lands between the AF position and +16. It sets an
     * offset from the position the last AF reached. Bodies without focus drive (such as the
     * ILCE-7) therefore cannot sweep the whole focus range from an app, only fine-tune around
     * the AF point; a new AF on another subject moves the base.
     *
     * shiftFocusPosition blocked indefinitely when called after app start without an AF
     * (upstream saw it block the ILCE-6000 too). So offsets are refused until an autoFocusAt
     * has succeeded (skipAfCheck bypasses this for diagnosis), and the call runs on its own
     * thread with a timeout, so a blocked call cannot freeze the main thread.
     */
    private JSONObject setFocusOffset(int offset, boolean skipAfCheck) throws Exception {
        if (m_activity.getAfMode().isContinuous()) {
            throw new IllegalStateException("Continuous AF is on, the camera focuses by itself: switch to single AF to fine-tune focus");
        }
        if (!m_afEstablished && !skipAfCheck) {
            throw new IllegalStateException("Focus offset needs an autofocus first: click the live view to AF, then use the knob");
        }
        synchronized (m_focusOpLock) {
            int max = Math.max(1, m_focusOffsetMax);
            int target = Math.max(-max, Math.min(max, offset));
            boolean accepted = true;
            if (target != m_focusOffset || offset == 0) {
                accepted = callShiftFocusPosition(target);
                if (accepted) {
                    m_focusOffset = target;
                }
            }
            JSONObject obj = focusShiftJson();
            obj.put("requested", offset);
            obj.put("accepted", accepted);
            obj.put("atLimit", target != offset);
            publishFocusShift();
            return obj;
        }
    }

    /** Runs one shiftFocusPosition on a dedicated thread; never on the main thread. */
    private boolean callShiftFocusPosition(final int chunk) throws Exception {
        if (m_shiftInFlight) {
            throw new IllegalStateException("A previous focus shift is still blocked in the camera; restart the app to recover focus control");
        }
        final CameraEx cam = m_activity.getCameraEx();
        if (cam == null) {
            throw new IllegalStateException("Camera not initialized");
        }
        final boolean[] result = new boolean[]{false};
        final Throwable[] error = new Throwable[]{null};
        final CountDownLatch done = new CountDownLatch(1);
        m_shiftInFlight = true;
        Thread worker = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    result[0] = cam.shiftFocusPosition(chunk);
                } catch (Throwable t) {
                    error[0] = t;
                } finally {
                    m_shiftInFlight = false;
                    done.countDown();
                }
            }
        }, "focus-shift");
        worker.setDaemon(true);
        worker.start();
        if (!done.await(FOCUS_SHIFT_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
            throw new TimeoutException("shiftFocusPosition(" + chunk + ") did not return within "
                    + FOCUS_SHIFT_TIMEOUT_MS + " ms; focus shift is disabled until it does");
        }
        if (error[0] instanceof Exception) {
            throw (Exception) error[0];
        }
        if (error[0] != null) {
            throw new RuntimeException(error[0]);
        }
        return result[0];
    }

    private int queryMaxFocusShift() {
        try {
            Integer max = m_activity.runOnMainSync(new Callable<Integer>() {
                @Override
                public Integer call() {
                    CameraEx cam = m_activity.getCameraEx();
                    if (cam == null) return DEFAULT_MAX_FOCUS_SHIFT;
                    CameraEx.ParametersModifier mod =
                            cam.createParametersModifier(cam.getNormalCamera().getParameters());
                    return mod.isSupportedFocusShift() ? mod.getMaxFocusShift() : DEFAULT_MAX_FOCUS_SHIFT;
                }
            }, MacroServerActivity.MAIN_THREAD_TIMEOUT_MS);
            return max != null && max > 0 ? max : DEFAULT_MAX_FOCUS_SHIFT;
        } catch (Throwable t) {
            return DEFAULT_MAX_FOCUS_SHIFT;
        }
    }

    // --- Closed-Loop Implementations ---

    private static double predictFocusStep(int zoomPos, int speed) {
        // Fallback to mid-tele (z=74) when optical zoom state is unavailable (e.g. prime lens)
        int z = (zoomPos >= 0) ? zoomPos : 74;
        return (0.0491 + 0.2667 * Math.pow(0.9634, z)) * Math.pow(2.615, speed);
    }

    private static int chooseFocusSpeed(int absDiff, int zoomPos, int zeroStreak, int reversals) {
        int chosen = 1;
        for (int s = 7; s >= 1; s--) {
            if (predictFocusStep(zoomPos, s) <= absDiff * 0.92) {
                chosen = s;
                break;
            }
        }
        // Keep predicted step >= 0.75 ticks to avoid sub-tick deadzones unless damping a tight ±1..2 bounce
        boolean allowSubtick = (reversals >= 2 && absDiff <= 2);
        if (!allowSubtick) {
            while (chosen < 7 && predictFocusStep(zoomPos, chosen) < 0.75) {
                chosen++;
            }
        }
        // Temporarily escalate speed after repeated ignored/zero-displacement pulses
        if (zeroStreak >= 3) {
            int boost = zeroStreak / 3;
            int cap = (absDiff <= 3) ? Math.min(7, chosen + 1) : 7;
            chosen = Math.min(cap, chosen + boost);
        }
        return chosen;
    }

    private JSONObject setFocusPosition(int targetPos, int tolerance) throws Exception {
        final long myGen = m_focus.nextGeneration();
        int zeroStreak = 0;
        int steps = 0;
        int reversals = 0;
        int lastDir = -1;

        for (int i = 0; i < 100; i++) {
            int current;
            boolean has;
            int maxPos;
            synchronized (m_focus) {
                if (!m_focus.isCurrent(myGen)) {
                    return buildResult(false, true, false, m_focus.v1, targetPos, steps);
                }
                has = m_focus.hasValue;
                current = m_focus.v1;
                maxPos = m_focus.max1;
            }
            if (!has) {
                throw new IllegalStateException("Focus position unavailable (ensure lens is in MF)");
            }

            int zoomPos;
            synchronized (m_zoom) {
                zoomPos = m_zoom.hasValue ? m_zoom.v1 : -1;
            }

            int clampedTarget = (maxPos > 0) ? Math.max(0, Math.min(maxPos, targetPos)) : targetPos;
            int diffToTarget = clampedTarget - current;
            int absDist = Math.abs(diffToTarget);
            if (absDist <= tolerance) {
                return buildResult(true, false, false, current, clampedTarget, steps);
            }

            final int dir = diffToTarget > 0 ? FOCUS_FAR : FOCUS_NEAR;
            if (lastDir != -1 && dir != lastDir) {
                reversals++;
            }
            lastDir = dir;

            final int speed = chooseFocusSpeed(absDist, zoomPos, zeroStreak, reversals);

            long seqBefore = m_focus.getUpdateSeq();
            driveOnMain(new Runnable() {
                @Override
                public void run() {
                    CameraEx cam = m_activity.getCameraEx();
                    if (cam != null) cam.startOneShotFocusDrive(dir, speed);
                }
            });
            steps++;

            m_focus.waitForChange(myGen, seqBefore, 200);
            int posAfter;
            synchronized (m_focus) {
                if (!m_focus.isCurrent(myGen)) {
                    return buildResult(false, true, false, m_focus.v1, clampedTarget, steps);
                }
                posAfter = m_focus.v1;
            }
            // If focus moved opposite to commanded direction, user manually turned the focus ring -> abort
            if ((dir == FOCUS_FAR && posAfter < current) || (dir == FOCUS_NEAR && posAfter > current)) {
                JSONObject aborted = buildResult(false, true, false, posAfter, clampedTarget, steps);
                aborted.put("manualOverride", true);
                return aborted;
            }
            if (posAfter == current) {
                zeroStreak++;
                if (zeroStreak >= 24) {
                    return buildResult(false, false, true, posAfter, clampedTarget, steps);
                }
            } else {
                zeroStreak = 0;
            }
        }

        synchronized (m_focus) {
            int clampedTarget = (m_focus.max1 > 0) ? Math.max(0, Math.min(m_focus.max1, targetPos)) : targetPos;
            boolean converged = Math.abs(clampedTarget - m_focus.v1) <= tolerance;
            return buildResult(converged, false, false, m_focus.v1, clampedTarget, steps);
        }
    }

    /**
     * Wait between the AF callback and the switch to manual focus. The lens is still settling
     * when the callback fires; switching at once (about 20-50 ms later, as before) froze it short
     * of the focus point, so the live view first got sharp and then blurred. Measured on the
     * ILCE-7 with the debug console from a defocused start: 0 ms ended at sharpness 24-41
     * against a peak of 54-77 during AF; 100, 250 and 500 ms all ended at the peak (76).
     */
    private static final long AF_SETTLE_MS = 300L;

    private JSONObject autoFocusAt(double nx, double ny) throws Exception {
        final double clampedX = Math.max(0.0, Math.min(1.0, nx));
        final double clampedY = Math.max(0.0, Math.min(1.0, ny));
        final AfModeController afMode = m_activity.getAfMode();
        if (afMode.isContinuous()) {
            // Continuous AF: go on in a spot here (switching Wide or Center to Spot), no single AF.
            JSONObject res = afMode.continuousClick(clampedX, clampedY);
            res.put("superseded", false);
            res.put("timedOut", false);
            return res;
        }
        final long myGen = m_focus.nextGeneration();

        synchronized (m_focusOpLock) {
            if (!m_focus.isCurrent(myGen)) {
                JSONObject res = new JSONObject();
                res.put("focused", false);
                res.put("superseded", true);
                res.put("timedOut", false);
                return res;
            }

            final Object afLock = new Object();
            final boolean[] afDone = new boolean[]{false};
            final boolean[] afSuccess = new boolean[]{false};
            final int[] targetPoint = new int[]{0, 0};

            try {
                driveOnMain(new Runnable() {
                    @Override
                    public void run() {
                        CameraEx cam = m_activity.getCameraEx();
                        if (cam == null) return;

                        try {
                            cam.stopPreviewMagnification();
                        } catch (Throwable ignored) {
                        }

                        Camera normal = cam.getNormalCamera();
                        try {
                            normal.cancelAutoFocus();
                        } catch (Throwable ignored) {
                        }

                        // Current focus area; in Spot mode the spot moves to the clicked point.
                        int[] pt = afMode.configureSingleAf(cam, clampedX, clampedY);
                        targetPoint[0] = pt[0];
                        targetPoint[1] = pt[1];

                        normal.autoFocus(new Camera.AutoFocusCallback() {
                            @Override
                            public void onAutoFocus(boolean success, Camera camera) {
                                synchronized (afLock) {
                                    afSuccess[0] = success;
                                    afDone[0] = true;
                                    afLock.notifyAll();
                                }
                            }
                        });
                    }
                });

                long deadline = System.currentTimeMillis() + 5000L;
                synchronized (afLock) {
                    while (!afDone[0] && m_focus.isCurrent(myGen)) {
                        long rem = deadline - System.currentTimeMillis();
                        if (rem <= 0) break;
                        try {
                            afLock.wait(Math.min(rem, 100L));
                        } catch (InterruptedException ignored) {
                            break;
                        }
                    }
                }
                if (afDone[0] && m_focus.isCurrent(myGen)) {
                    Thread.sleep(AF_SETTLE_MS);
                }
            } finally {
                try {
                    driveOnMain(new Runnable() {
                        @Override
                        public void run() {
                            CameraEx cam = m_activity.getCameraEx();
                            if (cam == null) return;
                            Camera normal = cam.getNormalCamera();
                            if (!afDone[0] || !m_focus.isCurrent(myGen)) {
                                try {
                                    normal.cancelAutoFocus();
                                } catch (Throwable ignored) {
                                }
                            }
                            try {
                                Camera.Parameters restore = cam.createEmptyParameters();
                                restore.setFocusMode(CameraEx.ParametersModifier.FOCUS_MODE_MANUAL);
                                normal.setParameters(restore);
                            } catch (Throwable ignored) {
                            }
                        }
                    });
                } catch (Throwable ignored) {
                }
            }

            int pos;
            synchronized (m_focus) {
                pos = m_focus.v1;
            }
            if (afSuccess[0]) {
                onAutoFocusSucceeded();
            }
            JSONObject res = new JSONObject();
            res.put("focused", afSuccess[0]);
            res.put("superseded", !m_focus.isCurrent(myGen));
            res.put("timedOut", !afDone[0]);
            res.put("x", targetPoint[0]);
            res.put("y", targetPoint[1]);
            res.put("position", pos);
            return res;
        }
    }

    private JSONObject setAperture(int targetF100) throws Exception {
        final long myGen = m_aperture.nextGeneration();
        int stalled = 0;
        int steps = 0;

        for (int i = 0; i < 45; i++) {
            int current;
            int minAp;
            int maxAp;
            boolean has;
            synchronized (m_aperture) {
                if (!m_aperture.isCurrent(myGen)) {
                    return buildResult(false, true, false, m_aperture.v1, targetF100, steps);
                }
                has = m_aperture.hasValue;
                current = m_aperture.v1;
                minAp = m_aperture.min1;
                maxAp = m_aperture.max1;
            }
            if (!has) {
                throw new IllegalStateException("Aperture state unavailable");
            }

            int clamped = targetF100;
            if (minAp > 0 && clamped < minAp) clamped = minAp;
            if (maxAp > 0 && clamped > maxAp) clamped = maxAp;

            int diff = clamped - current;
            if (Math.abs(diff) <= 15) {
                return buildResult(true, false, false, current, clamped, steps);
            }

            final boolean inc = diff > 0;
            long seqBefore = m_aperture.getUpdateSeq();
            driveOnMain(new Runnable() {
                @Override
                public void run() {
                    CameraEx cam = m_activity.getCameraEx();
                    if (cam != null) {
                        if (inc) cam.incrementAperture();
                        else cam.decrementAperture();
                    }
                }
            });
            steps++;

            m_aperture.waitForChange(myGen, seqBefore, 250);
            if (!m_aperture.isCurrent(myGen)) {
                synchronized (m_aperture) {
                    return buildResult(false, true, false, m_aperture.v1, clamped, steps);
                }
            }
            if (m_aperture.getUpdateSeq() == seqBefore) {
                stalled++;
                if (stalled >= 2) {
                    synchronized (m_aperture) {
                        return buildResult(false, false, true, m_aperture.v1, clamped, steps);
                    }
                }
            } else {
                stalled = 0;
            }
        }

        synchronized (m_aperture) {
            return buildResult(false, false, false, m_aperture.v1, targetF100, steps);
        }
    }

    private JSONObject setShutterSpeed(int targetN, int targetD) throws Exception {
        if (targetN <= 0 || targetD <= 0) {
            throw new IllegalArgumentException("Shutter numerator and denominator must be > 0");
        }
        final double targetSec = (double) targetN / (double) targetD;
        final long myGen = m_shutter.nextGeneration();
        int stalled = 0;
        int steps = 0;

        for (int i = 0; i < 65; i++) {
            int curN;
            int curD;
            boolean has;
            synchronized (m_shutter) {
                if (!m_shutter.isCurrent(myGen)) {
                    return buildShutterResult(false, true, false, m_shutter.v1, m_shutter.v2, targetN, targetD, steps);
                }
                has = m_shutter.hasValue;
                curN = m_shutter.v1;
                curD = m_shutter.v2;
            }
            if (!has || curD <= 0) {
                throw new IllegalStateException("Shutter speed state unavailable");
            }

            double curSec = (double) curN / (double) curD;
            double ratio = curSec / targetSec;
            // Within ~10% (less than 1/6 EV) is considered converged
            if (ratio >= 0.90 && ratio <= 1.11) {
                return buildShutterResult(true, false, false, curN, curD, targetN, targetD, steps);
            }

            // incrementShutterSpeed -> faster (smaller seconds), decrementShutterSpeed -> slower (larger seconds)
            final boolean faster = curSec > targetSec;
            long seqBefore = m_shutter.getUpdateSeq();
            driveOnMain(new Runnable() {
                @Override
                public void run() {
                    CameraEx cam = m_activity.getCameraEx();
                    if (cam != null) {
                        if (faster) cam.incrementShutterSpeed();
                        else cam.decrementShutterSpeed();
                    }
                }
            });
            steps++;

            m_shutter.waitForChange(myGen, seqBefore, 250);
            if (!m_shutter.isCurrent(myGen)) {
                synchronized (m_shutter) {
                    return buildShutterResult(false, true, false, m_shutter.v1, m_shutter.v2, targetN, targetD, steps);
                }
            }
            if (m_shutter.getUpdateSeq() == seqBefore) {
                stalled++;
                if (stalled >= 2) {
                    synchronized (m_shutter) {
                        return buildShutterResult(false, false, true, m_shutter.v1, m_shutter.v2, targetN, targetD, steps);
                    }
                }
            } else {
                stalled = 0;
            }
        }

        synchronized (m_shutter) {
            return buildShutterResult(false, false, false, m_shutter.v1, m_shutter.v2, targetN, targetD, steps);
        }
    }

    private JSONObject setZoomPosition(int targetPos, int tolerance) throws Exception {
        final long myGen = m_zoom.nextGeneration();
        int stalled = 0;
        int steps = 0;

        for (int i = 0; i < 80; i++) {
            int current;
            boolean has;
            synchronized (m_zoom) {
                if (!m_zoom.isCurrent(myGen)) {
                    return buildResult(false, true, false, m_zoom.v1, targetPos, steps);
                }
                has = m_zoom.hasValue;
                current = m_zoom.v1;
            }
            if (!has) {
                throw new IllegalStateException("Zoom state unavailable");
            }

            int diff = targetPos - current;
            if (Math.abs(diff) <= tolerance) {
                return buildResult(true, false, false, current, targetPos, steps);
            }

            final int dir = diff > 0 ? CameraEx.ZOOM_DIRECTION_TELE : CameraEx.ZOOM_DIRECTION_WIDE;
            final int speed = Math.abs(diff) > 12 ? 2 : 1;
            long seqBefore = m_zoom.getUpdateSeq();
            driveOnMain(new Runnable() {
                @Override
                public void run() {
                    CameraEx cam = m_activity.getCameraEx();
                    if (cam != null) cam.startZoom(dir, speed);
                }
            });
            steps++;

            m_zoom.waitForChange(myGen, seqBefore, 120);
            driveOnMain(new Runnable() {
                @Override
                public void run() {
                    CameraEx cam = m_activity.getCameraEx();
                    if (cam != null) cam.stopZoom();
                }
            });
            if (!m_zoom.isCurrent(myGen)) {
                synchronized (m_zoom) {
                    return buildResult(false, true, false, m_zoom.v1, targetPos, steps);
                }
            }
            if (m_zoom.getUpdateSeq() == seqBefore) {
                stalled++;
                if (stalled >= 2) {
                    synchronized (m_zoom) {
                        return buildResult(false, false, true, m_zoom.v1, targetPos, steps);
                    }
                }
            } else {
                stalled = 0;
            }
        }

        synchronized (m_zoom) {
            return buildResult(Math.abs(targetPos - m_zoom.v1) <= tolerance, false, false, m_zoom.v1, targetPos, steps);
        }
    }

    private void driveOnMain(final Runnable r) throws Exception {
        m_activity.runOnMainSync(new Callable<Void>() {
            @Override
            public Void call() {
                r.run();
                return null;
            }
        }, MacroServerActivity.MAIN_THREAD_TIMEOUT_MS);
    }

    private static JSONObject buildResult(boolean converged, boolean superseded, boolean stalled, int actual, int target, int steps) {
        JSONObject obj = new JSONObject();
        try {
            obj.put("converged", converged);
            obj.put("superseded", superseded);
            obj.put("stalled", stalled);
            obj.put("position", actual);
            obj.put("target", target);
            obj.put("steps", steps);
        } catch (Throwable ignored) {
        }
        return obj;
    }

    private static JSONObject buildShutterResult(boolean converged, boolean superseded, boolean stalled, int n, int d, int targetN, int targetD, int steps) {
        JSONObject obj = new JSONObject();
        try {
            obj.put("converged", converged);
            obj.put("superseded", superseded);
            obj.put("stalled", stalled);
            obj.put("currentShutterSpeed_n", n);
            obj.put("currentShutterSpeed_d", d);
            obj.put("target_n", targetN);
            obj.put("target_d", targetD);
            obj.put("steps", steps);
        } catch (Throwable ignored) {
        }
        return obj;
    }
}
