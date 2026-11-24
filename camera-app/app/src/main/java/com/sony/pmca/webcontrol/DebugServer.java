package com.sony.pmca.webcontrol;

import android.content.Context;
import android.content.SharedPreferences;

import com.github.ma1co.pmcademo.app.Logger;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.security.SecureRandom;
import java.util.LinkedList;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.TimeoutException;

import bsh.Interpreter;
import bsh.This;
import fi.iki.elonen.NanoHTTPD;

/**
 * Debug console on its own port: runs BeanShell (Java syntax, loosely typed) inside the app,
 * so camera behaviour can be explored without rebuilding the APK.
 *
 * Every request except GET / needs the key shown on the camera screen, as header
 * {@code X-Debug-Key} or parameter {@code key}. The key is random, generated once and kept in
 * the app's private preferences. Anyone with the key can run arbitrary code as this app.
 *
 * Endpoints:
 * <ul>
 * <li>POST /eval[?thread=worker|main][&timeout=ms][&reset=1] with the script as the body.
 * Runs on a worker thread by default; {@code dbg.main("...")} runs a piece on the main thread,
 * where camera calls belong. Variables persist between calls until reset=1.</li>
 * <li>GET /logcat[?lines=N] the last N lines of {@code logcat -d -v time}.</li>
 * </ul>
 */
public class DebugServer extends NanoHTTPD {

    public static final int PORT = 8081;
    private static final String PREFS = "debug";
    private static final String KEY_PREF = "key";
    private static final long DEFAULT_TIMEOUT_MS = 10000L;
    private static final long MAX_TIMEOUT_MS = 300000L;
    private static final int MAX_BODY = 256 * 1024;
    private static final int MAX_OUTPUT = 512 * 1024;

    private static final String HELP =
            "WebControl A7 debug console (BeanShell)\n"
            + "Auth: header X-Debug-Key: <key from the camera screen>, or ?key=\n\n"
            + "POST /eval[?thread=worker|main][&timeout=ms][&reset=1]   body = script\n"
            + "GET  /logcat[?lines=500]\n\n"
            + "Bound: activity, cam (CameraEx), normal (android.hardware.Camera), hub, goal, dbg\n"
            + "dbg.main(\"code\") runs code on the main thread (camera calls); dbg.sleep(ms);\n"
            + "dbg.proxy(Iface.class, this) turns a scripted object into an interface (callbacks);\n"
            + "dbg.frameSize() is the newest live view JPEG size (a rough sharpness signal).\n"
            + "print(x) goes to the response output. Never wait on the main thread for a\n"
            + "callback that the main thread delivers.\n";

    private final MacroServerActivity m_activity;
    private final String m_key;
    private final Object m_evalLock = new Object();
    private Interpreter m_interp;
    private final ByteArrayOutputStream m_out = new ByteArrayOutputStream();

    public DebugServer(MacroServerActivity activity) {
        super(PORT);
        m_activity = activity;
        m_key = loadKey(activity);
    }

    public String getKey() {
        return m_key;
    }

    private static String loadKey(Context ctx) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String k = p.getString(KEY_PREF, null);
        if (k == null || k.length() < 8) {
            byte[] b = new byte[4];
            new SecureRandom().nextBytes(b);
            StringBuilder sb = new StringBuilder();
            for (byte x : b) {
                sb.append(Integer.toHexString((x & 0xff) | 0x100).substring(1));
            }
            k = sb.toString();
            p.edit().putString(KEY_PREF, k).commit();
        }
        return k;
    }

    @Override
    public Response serve(IHTTPSession session) {
        String uri = session.getUri();
        Map<String, String> params = session.getParms();
        if ("/".equals(uri)) {
            return text(Response.Status.OK, HELP);
        }
        String key = session.getHeaders().get("x-debug-key");
        if (key == null) {
            key = params.get("key");
        }
        if (!m_key.equals(key)) {
            try {
                Thread.sleep(500); // slows down guessing
            } catch (InterruptedException ignored) {
            }
            return text(Response.Status.UNAUTHORIZED, "Wrong or missing debug key (shown on the camera screen)\n");
        }
        try {
            if ("/eval".equals(uri) && Method.POST.equals(session.getMethod())) {
                String script = readBody(session);
                long timeout = Math.max(100L, Math.min(MAX_TIMEOUT_MS, parseLong(params.get("timeout"), DEFAULT_TIMEOUT_MS)));
                JSONObject res = eval(script, "main".equals(params.get("thread")), timeout, "1".equals(params.get("reset")));
                return new Response(Response.Status.OK, "application/json", res.toString());
            }
            if ("/logcat".equals(uri)) {
                int lines = (int) Math.max(1, Math.min(20000, parseLong(params.get("lines"), 500)));
                return text(Response.Status.OK, logcat(lines));
            }
            return text(Response.Status.NOT_FOUND, "Unknown path\n\n" + HELP);
        } catch (Throwable t) {
            return text(Response.Status.INTERNAL_ERROR, stackTrace(t));
        }
    }

    // --- Script evaluation ---

    private void initInterpreter() throws Exception {
        m_out.reset();
        PrintStream ps = new PrintStream(m_out, true);
        Interpreter in = new Interpreter();
        in.setOut(ps);
        in.setErr(ps);
        in.set("activity", m_activity);
        in.set("cam", m_activity.getCameraEx());
        in.set("normal", m_activity.getCameraEx() != null ? m_activity.getCameraEx().getNormalCamera() : null);
        in.set("hub", m_activity.getEventHub());
        in.set("goal", m_activity.getGoalController());
        in.set("dbg", new Helpers());
        in.eval("import android.hardware.*; import android.graphics.*; import com.sony.scalar.hardware.*;"
                + " import com.sony.scalar.sysutil.*; import com.sony.pmca.webcontrol.*;"
                + " import org.json.*; import java.util.*; import java.io.*;");
        m_interp = in;
    }

    private JSONObject eval(final String script, boolean onMain, long timeoutMs, boolean reset) throws Exception {
        synchronized (m_evalLock) {
            if (m_interp == null || reset) {
                initInterpreter();
            }
            m_out.reset();
            final Interpreter in = m_interp;
            final Object[] result = new Object[]{null};
            final Throwable[] error = new Throwable[]{null};
            long t0 = System.currentTimeMillis();
            boolean timedOut = false;
            if (onMain) {
                try {
                    result[0] = m_activity.runOnMainSync(new Callable<Object>() {
                        @Override
                        public Object call() throws Exception {
                            return in.eval(script);
                        }
                    }, timeoutMs);
                } catch (Throwable t) {
                    error[0] = t;
                    timedOut = t instanceof TimeoutException;
                }
            } else {
                Thread th = new Thread(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            result[0] = in.eval(script);
                        } catch (Throwable t) {
                            error[0] = t;
                        }
                    }
                }, "debug-eval");
                th.setDaemon(true);
                th.start();
                th.join(timeoutMs);
                if (th.isAlive()) {
                    timedOut = true;
                    // The script keeps running; start a fresh interpreter for the next call.
                    m_interp = null;
                }
            }
            JSONObject o = new JSONObject();
            o.put("ok", error[0] == null && !timedOut);
            o.put("ms", System.currentTimeMillis() - t0);
            if (timedOut) {
                o.put("error", "Timed out after " + timeoutMs + " ms; the script may still be running"
                        + (onMain ? " on the main thread" : " (interpreter reset)"));
            } else if (error[0] != null) {
                o.put("error", stackTrace(error[0]));
            } else {
                Object r = result[0];
                o.put("resultClass", r != null ? r.getClass().getName() : null);
                o.put("result", toJsonValue(r));
            }
            String out = m_out.toString("UTF-8");
            if (out.length() > MAX_OUTPUT) {
                out = out.substring(out.length() - MAX_OUTPUT);
            }
            o.put("output", out);
            return o;
        }
    }

    private static Object toJsonValue(Object r) {
        if (r == null || r instanceof Boolean || r instanceof Number || r instanceof String
                || r instanceof JSONObject || r instanceof org.json.JSONArray) {
            return r != null ? r : JSONObject.NULL;
        }
        try {
            return RpcDispatcher.toJsonValue(r);
        } catch (Throwable t) {
            return String.valueOf(r);
        }
    }

    /** Helpers bound as {@code dbg} in scripts. */
    public class Helpers {
        /** Evaluates {@code code} on the main thread (5 s timeout) in the same interpreter. */
        public Object main(final String code) throws Exception {
            return main(code, 5000L);
        }

        public Object main(final String code, long timeoutMs) throws Exception {
            final Interpreter in = m_interp;
            return m_activity.runOnMainSync(new Callable<Object>() {
                @Override
                public Object call() throws Exception {
                    return in.eval(code);
                }
            }, timeoutMs);
        }

        public void sleep(long ms) throws InterruptedException {
            Thread.sleep(ms);
        }

        /** Makes a scripted object (a BeanShell {@code this}) implement {@code iface}. */
        public Object proxy(Class iface, This impl) throws Exception {
            return impl.getInterface(iface);
        }

        /** JPEG size of the newest live view frame; more detail (sharper) gives larger frames. */
        public int frameSize() {
            LiveViewManager.LiveViewFrame f = m_activity.getLiveViewManager().getLatestFrame();
            return f != null && f.jpeg != null ? f.jpeg.length : -1;
        }

        public long now() {
            return System.currentTimeMillis();
        }
    }

    // --- Logcat ---

    private static String logcat(int lines) throws Exception {
        Process p = Runtime.getRuntime().exec(new String[]{"logcat", "-d", "-v", "time"});
        LinkedList<String> tail = new LinkedList<String>();
        BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()), 8192);
        try {
            String line;
            while ((line = r.readLine()) != null) {
                tail.add(line);
                if (tail.size() > lines) {
                    tail.removeFirst();
                }
            }
        } finally {
            r.close();
            p.destroy();
        }
        StringBuilder sb = new StringBuilder();
        for (String s : tail) {
            sb.append(s).append('\n');
        }
        if (tail.isEmpty()) {
            sb.append("(logcat returned nothing; the app may lack READ_LOGS)\n");
        }
        return sb.toString();
    }

    // --- Helpers ---

    private static String readBody(IHTTPSession session) throws Exception {
        String lenStr = session.getHeaders().get("content-length");
        int len = (int) parseLong(lenStr, 0);
        if (len <= 0) {
            return "";
        }
        if (len > MAX_BODY) {
            throw new IllegalArgumentException("Script larger than " + MAX_BODY + " bytes");
        }
        InputStream is = session.getInputStream();
        byte[] buf = new byte[len];
        int off = 0;
        while (off < len) {
            int n = is.read(buf, off, len - off);
            if (n < 0) {
                break;
            }
            off += n;
        }
        return new String(buf, 0, off, "UTF-8");
    }

    private static long parseLong(String s, long def) {
        if (s == null) {
            return def;
        }
        try {
            return Long.parseLong(s.trim());
        } catch (NumberFormatException e) {
            return def;
        }
    }

    private static String stackTrace(Throwable t) {
        StringWriter sw = new StringWriter();
        t.printStackTrace(new PrintWriter(sw));
        return sw.toString();
    }

    private static Response text(Response.IStatus status, String body) {
        return new Response(status, "text/plain; charset=utf-8", body);
    }

    @Override
    public void stop() {
        super.stop();
        Logger.info("Debug server stopped");
    }
}
