package com.sony.pmca.webcontrol;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.BitmapRegionDecoder;
import android.graphics.Rect;

import com.github.ma1co.pmcademo.app.Logger;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;

/**
 * Crop applied to the output stream ({@code /api/output.mjpeg}, {@code /api/output.jpg}).
 *
 * The rectangle is normalized (0..1) in the unrotated live view image. Each live view JPEG is
 * cropped with BitmapRegionDecoder, which decodes only the requested region, and re-encoded.
 * The last result is cached by frame sequence number, so several output clients share one
 * decode per frame. Without a crop, output frames are the live view frames unchanged.
 */
public class OutputCropper {

    private static final int JPEG_QUALITY = 85;
    /** Smallest crop side, as a fraction of the frame. */
    private static final float MIN_SIDE = 0.02f;
    /**
     * Longest output side. Live view frames are 640 px, but right after a capture the stream
     * carries the full-size photo; decoding a region of that unscaled could exhaust memory.
     */
    private static final int MAX_OUTPUT_SIDE = 1280;

    private boolean m_enabled;
    private float m_x, m_y, m_w = 1f, m_h = 1f;
    /** Bumped on every crop change so cached frames from the previous crop are not reused. */
    private long m_cropVersion;

    private long m_cachedSeq = -1;
    private long m_cachedVersion = -1;
    private byte[] m_cachedJpeg;

    public synchronized void set(float x, float y, float w, float h) {
        float cx = clamp(x, 0f, 1f - MIN_SIDE);
        float cy = clamp(y, 0f, 1f - MIN_SIDE);
        m_x = cx;
        m_y = cy;
        m_w = clamp(w, MIN_SIDE, 1f - cx);
        m_h = clamp(h, MIN_SIDE, 1f - cy);
        m_enabled = true;
        m_cropVersion++;
    }

    public synchronized void clear() {
        m_enabled = false;
        m_x = 0f;
        m_y = 0f;
        m_w = 1f;
        m_h = 1f;
        m_cropVersion++;
    }

    public synchronized JSONObject toJson() {
        JSONObject o = new JSONObject();
        try {
            o.put("enabled", m_enabled);
            o.put("x", m_x);
            o.put("y", m_y);
            o.put("w", m_w);
            o.put("h", m_h);
        } catch (Throwable ignored) {
        }
        return o;
    }

    /** Returns the output JPEG for a live view frame: cropped if a crop is set, else unchanged. */
    public byte[] apply(long seq, byte[] jpeg) {
        if (jpeg == null) {
            return null;
        }
        float x, y, w, h;
        long version;
        synchronized (this) {
            if (!m_enabled) {
                return jpeg;
            }
            if (seq == m_cachedSeq && m_cropVersion == m_cachedVersion && m_cachedJpeg != null) {
                return m_cachedJpeg;
            }
            x = m_x;
            y = m_y;
            w = m_w;
            h = m_h;
            version = m_cropVersion;
        }
        byte[] out = crop(jpeg, x, y, w, h);
        if (out == null) {
            return jpeg;
        }
        synchronized (this) {
            if (version == m_cropVersion) {
                m_cachedSeq = seq;
                m_cachedVersion = version;
                m_cachedJpeg = out;
            }
        }
        return out;
    }

    private static byte[] crop(byte[] jpeg, float x, float y, float w, float h) {
        BitmapRegionDecoder decoder = null;
        Bitmap region = null;
        try {
            decoder = BitmapRegionDecoder.newInstance(jpeg, 0, jpeg.length, false);
            int iw = decoder.getWidth();
            int ih = decoder.getHeight();
            int left = Math.round(x * iw);
            int top = Math.round(y * ih);
            int right = Math.max(left + 1, Math.min(iw, Math.round((x + w) * iw)));
            int bottom = Math.max(top + 1, Math.min(ih, Math.round((y + h) * ih)));
            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = 1;
            while (Math.max(right - left, bottom - top) / opts.inSampleSize > MAX_OUTPUT_SIDE) {
                opts.inSampleSize *= 2;
            }
            region = decoder.decodeRegion(new Rect(left, top, right, bottom), opts);
            if (region == null) {
                return null;
            }
            ByteArrayOutputStream bos = new ByteArrayOutputStream(jpeg.length);
            region.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, bos);
            return bos.toByteArray();
        } catch (Throwable t) {
            Logger.error("Output crop failed: " + t.toString());
            return null;
        } finally {
            if (region != null) {
                region.recycle();
            }
            if (decoder != null) {
                decoder.recycle();
            }
        }
    }

    private static float clamp(float v, float lo, float hi) {
        return Math.max(lo, Math.min(hi, v));
    }
}
