import { useState } from 'react';
import type { CameraClient } from '../api/cameraClient';

interface WebcamPanelProps {
  client: CameraClient;
  connected: boolean;
  cropEnabled: boolean;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // navigator.clipboard needs a secure context; the camera serves plain http.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  }
}

function StreamRow({ label, url, hint }: { label: string; url: string; hint: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="webcam-row">
      <span className="quality-label" title={hint}>
        {label}
      </span>
      <input className="input-text webcam-url" readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label={`${label} stream URL`} />
      <button
        type="button"
        className="btn btn-sm"
        onClick={() =>
          void copyText(url).then((ok) => {
            setCopied(ok);
            window.setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/**
 * Webcam mode: the camera's live view as an MJPEG stream for OBS (Media Source), VLC or ffmpeg.
 * Nothing is saved; a shutter press still stores to the SD card.
 */
export function WebcamPanel({ client, connected, cropEnabled }: WebcamPanelProps) {
  const base = new URL(client.outputMjpegUrl());
  const full = new URL('/api/liveview.mjpeg', base).toString();
  const output = base.toString();

  return (
    <section className="panel">
      <div className="panel-header">
        <div className="panel-title">
          <span>Webcam</span>
          {connected && <span className="badge badge-live">streaming</span>}
        </div>
      </div>
      <StreamRow label="Full" url={full} hint="Whole live view frame" />
      <StreamRow
        label="Output"
        url={output}
        hint="Live view with the crop from the live view's Crop tool applied"
      />
      <p className="quality-note">
        MJPEG, 640 px wide, up to about 18 fps (the camera's live view; fewer in dim light and with more viewers). {cropEnabled ? 'Output is cropped.' : 'Output equals Full until you set a crop (✂ in the live view).'} Up to 3 viewers at once, including this page.
      </p>
      <p className="quality-note">
        OBS: Sources → Media Source → uncheck Local File → paste the URL → FFmpeg Options use_wallclock_as_timestamps=1 (else it jerks about once a second: the stream has no timestamps and FFmpeg assumes 25 fps) → Network Buffering 0 MB (else it lags by seconds). Photos are not saved in this mode unless you press the shutter (then only to the SD card).
      </p>
    </section>
  );
}
