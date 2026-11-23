package com.sony.pmca.webcontrol;

import com.github.ma1co.pmcademo.app.Logger;
import com.sony.scalar.hardware.CameraEx;

import org.json.JSONObject;

import java.util.concurrent.Callable;

/**
 * Timelapse scheduler that runs on the camera, so a shoot continues when the browser closes.
 *
 * Shot i (1-based) is due at start + (i - 1) * interval. Each shot is triggered on the main
 * thread like the physical shutter key (burstableTakePicture; the shutter listener cancels the
 * burst after one frame), then the scheduler waits until the image is stored before the next.
 * If a shot finishes after the next one was due, that next shot fires immediately and counts
 * as late; the schedule does not shift. Focus is whatever the body has (the app keeps it in
 * manual after an autofocus), so the whole series uses one focus.
 *
 * Publishes state "timelapse" and a Timelapse event after every change.
 */
public class TimelapseController {

    public static final long MIN_INTERVAL_MS = 1000L;
    public static final int MAX_FRAMES = 100000;
    /** Longest wait for a shot to be stored before the scheduler gives up on it. */
    private static final long SHOT_TIMEOUT_MS = 30000L;

    private final MacroServerActivity m_activity;
    private final Object m_lock = new Object();

    private Thread m_thread;
    private boolean m_running;
    private boolean m_stopRequested;
    private int m_frames;
    private long m_intervalMs;
    private long m_startedAt;
    private long m_nextShotAt;
    private int m_shot;
    private int m_late;
    private int m_failed;
    private String m_error;
    private String m_finishReason;

    /** Bumped by the camera listeners; the scheduler waits for it to change. */
    private long m_storedCount;
    private long m_captureEndCount;

    public TimelapseController(MacroServerActivity activity) {
        m_activity = activity;
    }

    // --- Camera listener hooks (main thread) ---

    public void onCaptureEnd() {
        synchronized (m_lock) {
            m_captureEndCount++;
            m_lock.notifyAll();
        }
    }

    public void onStoreImageComplete() {
        synchronized (m_lock) {
            m_storedCount++;
            m_lock.notifyAll();
        }
    }

    // --- Control ---

    public JSONObject start(int frames, long intervalMs) throws Exception {
        if (frames < 1 || frames > MAX_FRAMES) {
            throw new IllegalArgumentException("frames must be 1.." + MAX_FRAMES);
        }
        if (intervalMs < MIN_INTERVAL_MS) {
            throw new IllegalArgumentException("intervalMs must be at least " + MIN_INTERVAL_MS);
        }
        synchronized (m_lock) {
            if (m_running) {
                throw new IllegalStateException("A timelapse is already running");
            }
            m_running = true;
            m_stopRequested = false;
            m_frames = frames;
            m_intervalMs = intervalMs;
            m_startedAt = System.currentTimeMillis();
            m_nextShotAt = m_startedAt;
            m_shot = 0;
            m_late = 0;
            m_failed = 0;
            m_error = null;
            m_finishReason = null;
            m_thread = new Thread(new Runnable() {
                @Override
                public void run() {
                    runSchedule();
                }
            }, "timelapse");
            m_thread.setDaemon(true);
            m_thread.start();
        }
        publish();
        return toJson();
    }

    public JSONObject stop() {
        synchronized (m_lock) {
            if (m_running) {
                m_stopRequested = true;
                m_lock.notifyAll();
            }
        }
        return toJson();
    }

    public JSONObject toJson() {
        JSONObject o = new JSONObject();
        synchronized (m_lock) {
            try {
                o.put("running", m_running);
                o.put("frames", m_frames);
                o.put("intervalMs", m_intervalMs);
                o.put("startedAt", m_startedAt);
                o.put("nextShotAt", m_running ? m_nextShotAt : 0);
                o.put("shot", m_shot);
                o.put("late", m_late);
                o.put("failed", m_failed);
                o.put("now", System.currentTimeMillis());
                if (m_error != null) o.put("error", m_error);
                if (m_finishReason != null) o.put("finished", m_finishReason);
            } catch (Throwable ignored) {
            }
        }
        return o;
    }

    // --- Scheduler thread ---

    private void runSchedule() {
        String reason = "completed";
        try {
            for (int i = 1; i <= m_frames; i++) {
                long due = m_startedAt + (i - 1) * m_intervalMs;
                synchronized (m_lock) {
                    m_nextShotAt = due;
                }
                publish();
                if (!waitUntil(due)) {
                    reason = "stopped";
                    break;
                }
                boolean late = System.currentTimeMillis() - due > Math.min(1000L, m_intervalMs / 2);
                boolean ok = shootOne();
                synchronized (m_lock) {
                    m_shot = i;
                    if (late) m_late++;
                    if (!ok) m_failed++;
                }
                publish();
                synchronized (m_lock) {
                    if (m_stopRequested) {
                        reason = "stopped";
                        break;
                    }
                }
            }
        } catch (Throwable t) {
            reason = "error";
            synchronized (m_lock) {
                m_error = t.toString();
            }
            Logger.error("Timelapse failed: " + t.toString());
        } finally {
            synchronized (m_lock) {
                m_running = false;
                m_finishReason = reason;
                m_thread = null;
            }
            publish();
        }
    }

    /** Sleeps until {@code at}; false if a stop was requested meanwhile. */
    private boolean waitUntil(long at) throws InterruptedException {
        synchronized (m_lock) {
            while (!m_stopRequested) {
                long left = at - System.currentTimeMillis();
                if (left <= 0) {
                    return true;
                }
                m_lock.wait(Math.min(left, 1000L));
            }
            return false;
        }
    }

    /** Takes one picture and waits until it is stored (or the capture ends with nothing stored). */
    private boolean shootOne() throws Exception {
        long storedBefore;
        long endBefore;
        synchronized (m_lock) {
            storedBefore = m_storedCount;
            endBefore = m_captureEndCount;
        }
        m_activity.runOnMainSync(new Callable<Void>() {
            @Override
            public Void call() {
                CameraEx cam = m_activity.getCameraEx();
                if (cam == null) {
                    throw new IllegalStateException("Camera not initialized");
                }
                cam.burstableTakePicture();
                return null;
            }
        }, MacroServerActivity.MAIN_THREAD_TIMEOUT_MS);

        long deadline = System.currentTimeMillis() + SHOT_TIMEOUT_MS;
        synchronized (m_lock) {
            while (m_storedCount == storedBefore) {
                long left = deadline - System.currentTimeMillis();
                if (left <= 0) {
                    Logger.error("Timelapse shot was not stored within " + SHOT_TIMEOUT_MS + " ms");
                    return false;
                }
                // A capture that ended without storing (e.g. no card) would otherwise wait the
                // full timeout; give storing a few seconds after the capture end.
                if (m_captureEndCount != endBefore) {
                    deadline = Math.min(deadline, System.currentTimeMillis() + 10000L);
                    endBefore = m_captureEndCount;
                }
                m_lock.wait(Math.min(left, 500L));
            }
            return true;
        }
    }

    private void publish() {
        try {
            JSONObject data = toJson();
            CameraEventHub hub = m_activity.getEventHub();
            if (hub != null) {
                hub.setState("timelapse", data);
                hub.emit("Timelapse", toJson());
            }
        } catch (Throwable ignored) {
        }
    }
}
