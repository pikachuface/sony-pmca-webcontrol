package com.sony.pmca.webcontrol;

import android.hardware.Camera;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Still image quality: file format (RAW, JPEG, RAW+JPEG), JPEG quality, image size and aspect.
 *
 * Uses the body's own Camera.Parameters keys. Values seen on the ILCE-7:
 * storage-fmt jpeg, raw, rawjpeg; jpeg-quality 95, 50, 25; image-size large, midium, small
 * (Sony's spelling); image-aspect 3:2, 16:9. picture-size is read back to report the pixel size
 * that results. Every write is checked against the body's "-values" list first, so an unknown
 * value fails with a clear message instead of being silently ignored by the camera.
 */
public final class CaptureSettings {

    static final String FORMAT = "storage-fmt";
    static final String JPEG_QUALITY = "jpeg-quality";
    static final String IMAGE_SIZE = "image-size";
    static final String ASPECT = "image-aspect";
    static final String PICTURE_SIZE = "picture-size";

    private CaptureSettings() {
    }

    /** {format, jpegQuality, imageSize, aspect, pictureSize} plus the allowed values of each. */
    public static JSONObject toJson(Camera.Parameters p) {
        JSONObject o = new JSONObject();
        if (p == null) {
            return o;
        }
        try {
            putSetting(o, p, "format", FORMAT);
            putSetting(o, p, "jpegQuality", JPEG_QUALITY);
            putSetting(o, p, "imageSize", IMAGE_SIZE);
            putSetting(o, p, "aspect", ASPECT);
            String size = p.get(PICTURE_SIZE);
            if (size != null) {
                o.put("pictureSize", size);
            }
        } catch (Throwable ignored) {
        }
        return o;
    }

    /**
     * Copies the requested fields of {@code want} ({format, jpegQuality, imageSize, aspect};
     * missing or null fields stay as they are) into {@code out}, a partial parameter write.
     *
     * @return the number of keys written
     * @throws IllegalArgumentException when a value is not in the body's list
     */
    public static int apply(Camera.Parameters current, Camera.Parameters out, JSONObject want) throws Exception {
        int n = 0;
        n += copy(current, out, want, "format", FORMAT);
        n += copy(current, out, want, "jpegQuality", JPEG_QUALITY);
        n += copy(current, out, want, "imageSize", IMAGE_SIZE);
        n += copy(current, out, want, "aspect", ASPECT);
        return n;
    }

    private static void putSetting(JSONObject o, Camera.Parameters p, String field, String key) throws Exception {
        String v = p.get(key);
        if (v != null) {
            o.put(field, v);
        }
        String values = p.get(key + "-values");
        if (values != null) {
            JSONArray arr = new JSONArray();
            for (String s : values.split(",")) {
                if (s.trim().length() > 0) {
                    arr.put(s.trim());
                }
            }
            o.put(field + "Values", arr);
        }
    }

    private static int copy(Camera.Parameters current, Camera.Parameters out, JSONObject want,
                            String field, String key) throws Exception {
        if (want == null || !want.has(field) || want.isNull(field)) {
            return 0;
        }
        String value = String.valueOf(want.get(field)).trim();
        String values = current.get(key + "-values");
        if (values == null) {
            throw new IllegalArgumentException(field + " (" + key + ") is not supported by this body");
        }
        for (String s : values.split(",")) {
            if (s.trim().equals(value)) {
                out.set(key, value);
                return 1;
            }
        }
        throw new IllegalArgumentException(field + " must be one of " + values + ", got " + value);
    }
}
