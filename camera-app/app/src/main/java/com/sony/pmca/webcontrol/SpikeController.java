package com.sony.pmca.webcontrol;

import android.graphics.Rect;
import android.hardware.Camera;

import com.github.ma1co.pmcademo.app.Logger;
import com.sony.scalar.hardware.CameraEx;
import com.sony.scalar.media.MediaRecorder;
import com.sony.scalar.meta.FaceInfo;
import com.sony.scalar.provider.AvindexStore;
import com.sony.scalar.sysutil.ScalarProperties;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Experimental probes for capabilities that are not known to work on every body
 * (written against the ILCE-7, whose firmware reports isFocusDriveSupported() == false).
 *
 * Reached through {@code POST /api/call} with {@code "target": "spike"}:
 * <ul>
 *   <li>{@code probe()} - platform version, media ids, MediaRecorder parameters, focus/face flags</li>
 *   <li>{@code shiftFocus(steps)} - CameraEx.shiftFocusPosition, the relative focus shift Sony's
 *       Bracket Pro uses. Blacklisted in the generic RPC because it blocked the ILCE-6000 main thread.</li>
 *   <li>{@code faceStart(type)} / {@code faceStop()} - face detection with results streamed as
 *       {@code FaceDetected} events</li>
 *   <li>{@code movieStart(reopen)} / {@code movieStop()} - MediaRecorder to the memory card;
 *       with reopen=true the camera is first reopened in movie recording mode, as Sony's
 *       Smart Remote Control does</li>
 * </ul>
 * Not part of the stable API; results decide which features the fork builds on.
 */
public class SpikeController {

    private static final long REOPEN_TIMEOUT_MS = 10000L;
    private static final long FACE_EVENT_MIN_INTERVAL_MS = 200L;

    private static final int RECORDING_MODE_STILL = 0;
    private static final int RECORDING_MODE_MOVIE = 1;

    private final MacroServerActivity m_activity;
    private MediaRecorder m_recorder;
    private boolean m_movieMode;
    private long m_lastFaceEventMs;
    private int m_lastFaceCount = -1;

    public SpikeController(MacroServerActivity activity) {
        m_activity = activity;
    }

    public JSONObject execute(String method, JSONArray args) throws Exception {
        if ("probe".equals(method)) {
            return probe();
        }
        if ("shiftFocus".equals(method)) {
            return shiftFocus(args.getInt(0));
        }
        if ("faceStart".equals(method)) {
            return faceStart(args != null && args.length() > 0 ? args.getInt(0) : 0);
        }
        if ("faceStop".equals(method)) {
            return faceStop();
        }
        if ("movieStart".equals(method)) {
            return movieStart(args != null && args.length() > 0 && args.getBoolean(0));
        }
        if ("movieStop".equals(method)) {
            return movieStop();
        }
        throw new NoSuchMethodException("Unknown spike method: " + method);
    }

    /** Releases a running recording and returns the camera to still mode (called from onPause). */
    public void shutdown() {
        if (m_recorder != null) {
            try {
                m_recorder.stop();
            } catch (Throwable ignored) {
            }
            try {
                m_recorder.release();
            } catch (Throwable ignored) {
            }
            m_recorder = null;
        }
        m_movieMode = false;
    }

    // --- probe ---

    private JSONObject probe() throws Exception {
        return onMain(new Callable<JSONObject>() {
            @Override
            public JSONObject call() throws Exception {
                CameraEx cam = requireCamera();
                JSONObject out = new JSONObject();
                out.put("platform", ScalarProperties.getString("version.platform"));
                out.put("movieMode", m_movieMode);

                try {
                    JSONArray media = new JSONArray();
                    for (String id : AvindexStore.getExternalMediaIds()) {
                        media.put(id);
                    }
                    out.put("externalMediaIds", media);
                } catch (Throwable t) {
                    out.put("externalMediaIdsError", t.toString());
                }

                Camera.Parameters params = cam.getNormalCamera().getParameters();
                CameraEx.ParametersModifier mod = cam.createParametersModifier(params);
                try {
                    out.put("isFocusDriveSupported", mod.isFocusDriveSupported());
                    out.put("maxFocusDriveSpeed", mod.getMaxFocusDriveSpeed());
                } catch (Throwable t) {
                    out.put("focusDriveError", t.toString());
                }
                try {
                    out.put("isSupportedFocusShift", mod.isSupportedFocusShift());
                    out.put("minFocusShift", mod.getMinFocusShift());
                    out.put("maxFocusShift", mod.getMaxFocusShift());
                } catch (Throwable t) {
                    out.put("focusShiftError", t.toString());
                }
                try {
                    out.put("faceDetectionMode", mod.getFaceDetectionMode());
                    out.put("supportedFaceDetectionModes", RpcDispatcher.toJsonValue(mod.getSupportedFaceDetectionModes()));
                    out.put("maxNumDetectedFaces", mod.getMaxNumDetectedFaces());
                } catch (Throwable t) {
                    out.put("faceError", t.toString());
                }

                MediaRecorder probe = null;
                try {
                    probe = new MediaRecorder();
                    out.put("recorderSupportedParameters", probe.getSupportedParameters().flatten());
                    out.put("recorderParameters", probe.getParameters().flatten());
                } catch (Throwable t) {
                    out.put("recorderError", t.toString());
                } finally {
                    if (probe != null) {
                        try {
                            probe.release();
                        } catch (Throwable ignored) {
                        }
                    }
                }
                return out;
            }
        });
    }

    // --- focus shift ---

    private JSONObject shiftFocus(final int steps) throws Exception {
        final long start = System.currentTimeMillis();
        Boolean accepted = onMain(new Callable<Boolean>() {
            @Override
            public Boolean call() throws Exception {
                return requireCamera().shiftFocusPosition(steps);
            }
        });
        JSONObject out = new JSONObject();
        out.put("steps", steps);
        out.put("accepted", accepted);
        out.put("elapsedMs", System.currentTimeMillis() - start);
        return out;
    }

    // --- face detection ---

    private JSONObject faceStart(final int type) throws Exception {
        onMain(new Callable<Void>() {
            @Override
            public Void call() throws Exception {
                CameraEx cam = requireCamera();
                cam.setFaceDetectionListener(new CameraEx.FaceDetectionListener() {
                    @Override
                    public void onFaceDetected(FaceInfo[] faces, CameraEx cameraEx) {
                        emitFaces(faces);
                    }
                });
                cam.startFaceDetection(type);
                return null;
            }
        });
        JSONObject out = new JSONObject();
        out.put("started", true);
        out.put("type", type);
        return out;
    }

    private JSONObject faceStop() throws Exception {
        onMain(new Callable<Void>() {
            @Override
            public Void call() throws Exception {
                CameraEx cam = requireCamera();
                cam.stopFaceDetection();
                cam.setFaceDetectionListener(null);
                return null;
            }
        });
        JSONObject out = new JSONObject();
        out.put("stopped", true);
        return out;
    }

    private void emitFaces(FaceInfo[] faces) {
        int count = faces == null ? 0 : faces.length;
        long now = System.currentTimeMillis();
        // Faces arrive per preview frame; only forward changes and a bounded rate.
        if (count == m_lastFaceCount && now - m_lastFaceEventMs < FACE_EVENT_MIN_INTERVAL_MS) {
            return;
        }
        m_lastFaceCount = count;
        m_lastFaceEventMs = now;
        try {
            JSONArray arr = new JSONArray();
            for (int i = 0; i < count; i++) {
                FaceInfo f = faces[i];
                JSONObject o = new JSONObject();
                o.put("id", f.id);
                o.put("score", f.score);
                Rect r = f.rect;
                if (r != null) {
                    o.put("rect", new JSONArray().put(r.left).put(r.top).put(r.right).put(r.bottom));
                }
                arr.put(o);
            }
            JSONObject data = new JSONObject();
            data.put("count", count);
            data.put("faces", arr);
            m_activity.getEventHub().setState("faces", data);
            m_activity.getEventHub().emit("FaceDetected", data);
        } catch (Throwable t) {
            Logger.error("FaceDetected emit error: " + t.toString());
        }
    }

    // --- movie recording ---

    private JSONObject movieStart(boolean reopen) throws Exception {
        if (m_recorder != null) {
            throw new IllegalStateException("Recording already running");
        }
        JSONObject out = new JSONObject();
        if (reopen && !m_movieMode) {
            out.put("reopenMs", reopenCamera(RECORDING_MODE_MOVIE));
            m_movieMode = true;
        }
        onMain(new Callable<Void>() {
            @Override
            public Void call() throws Exception {
                CameraEx cam = requireCamera();
                MediaRecorder rec = new MediaRecorder();
                try {
                    rec.setVideoSource(1);
                    rec.setOutputMedia(AvindexStore.getExternalMediaIds()[0]);
                    rec.setCamera(cam);
                    rec.setOnErrorListener(new MediaRecorder.OnErrorListener() {
                        @Override
                        public void onError(int what, MediaRecorder mr) {
                            emitMovie("MovieError", "what", what);
                        }
                    });
                    rec.setOnRecordListener(new MediaRecorder.OnRecordListener() {
                        @Override
                        public void onStarted(boolean ok, MediaRecorder mr) {
                            emitMovie("MovieStarted", "ok", ok);
                        }

                        @Override
                        public void onStopped(MediaRecorder mr) {
                            emitMovie("MovieStopped", "ok", true);
                        }
                    });
                    rec.setOnRecTimeListener(new MediaRecorder.OnRecTimeListener() {
                        @Override
                        public void onChanged(int seconds, MediaRecorder mr) {
                            emitMovie("MovieRecTime", "seconds", seconds);
                        }
                    });
                    rec.prepare();
                    rec.start();
                } catch (Exception e) {
                    try {
                        rec.release();
                    } catch (Throwable ignored) {
                    }
                    throw e;
                }
                m_recorder = rec;
                return null;
            }
        });
        out.put("recording", true);
        out.put("movieMode", m_movieMode);
        return out;
    }

    private JSONObject movieStop() throws Exception {
        JSONObject out = new JSONObject();
        onMain(new Callable<Void>() {
            @Override
            public Void call() throws Exception {
                if (m_recorder != null) {
                    try {
                        m_recorder.stop();
                    } finally {
                        m_recorder.release();
                        m_recorder = null;
                    }
                }
                return null;
            }
        });
        if (m_movieMode) {
            out.put("reopenMs", reopenCamera(RECORDING_MODE_STILL));
            m_movieMode = false;
        }
        out.put("recording", false);
        return out;
    }

    private void emitMovie(String type, String key, Object value) {
        try {
            JSONObject data = new JSONObject();
            data.put(key, value);
            m_activity.getEventHub().emit(type, data);
        } catch (Throwable ignored) {
        }
    }

    /** Reopens the camera in the given recording mode and restarts preview and live view. */
    private long reopenCamera(final int recordingMode) throws Exception {
        final long start = System.currentTimeMillis();
        final CountDownLatch reopened = new CountDownLatch(1);
        onMain(new Callable<Void>() {
            @Override
            public Void call() throws Exception {
                CameraEx cam = requireCamera();
                m_activity.getLiveViewManager().stop();
                CameraEx.OpenOptions opts = new CameraEx.OpenOptions();
                opts.setPreview(true);
                opts.setInheritSetting(true);
                opts.setRecordingMode(recordingMode);
                if (recordingMode == RECORDING_MODE_STILL) {
                    opts.setTargetMedia(AvindexStore.getExternalMediaIds()[0]);
                }
                cam.reopen(opts, new CameraEx.OpenCallback() {
                    @Override
                    public void onReopened(CameraEx cameraEx) {
                        reopened.countDown();
                    }
                });
                return null;
            }
        });
        if (!reopened.await(REOPEN_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
            throw new TimeoutException("Camera reopen (mode " + recordingMode + ") timed out");
        }
        onMain(new Callable<Void>() {
            @Override
            public Void call() throws Exception {
                m_activity.restartPreview();
                return null;
            }
        });
        return System.currentTimeMillis() - start;
    }

    private CameraEx requireCamera() {
        CameraEx cam = m_activity.getCameraEx();
        if (cam == null) {
            throw new IllegalStateException("Camera not initialized");
        }
        return cam;
    }

    private <T> T onMain(Callable<T> task) throws Exception {
        return m_activity.runOnMainSync(task, MacroServerActivity.MAIN_THREAD_TIMEOUT_MS);
    }
}
