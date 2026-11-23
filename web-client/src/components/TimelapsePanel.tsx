import { useEffect, useMemo, useState } from 'react';
import type { TimelapseState } from '../api/cameraClient';

interface TimelapsePanelProps {
  connected: boolean;
  timelapse?: TimelapseState;
  /** Size of the last captured JPEG, which is what the PC receives per frame. */
  lastJpegBytes: number | null;
  /** Measured download speed in bytes/s, or null before any download. */
  transferBps: number | null;
  pcSaved: number;
  pcSkipped: number;
  /** This tab is saving the running timelapse's frames to the PC. */
  pcSeriesActive: boolean;
  saveTarget: string;
  onStart: (frames: number, intervalMs: number, saveToPc: boolean) => Promise<void>;
  onStop: () => Promise<void>;
  onError: (msg: string) => void;
}

interface Inputs {
  hours: string;
  minutes: string;
  fps: string;
  videoSeconds: string;
  photoMB: string;
  saveToPc: boolean;
}

const STORAGE_KEY = 'pmca_timelapse_inputs';
const FPS_CHOICES = [24, 25, 30, 50, 60];
const MIN_INTERVAL_S = 1;
/** Below this the camera may still be writing the previous RAW when the next shot is due. */
const TIGHT_INTERVAL_S = 3;
/** Wi-Fi photo download speed measured on the ILCE-7 (25 MB ARW in 11 s), until this tab measures its own. */
const MEASURED_BPS = 2.28e6;
const DEFAULT_INPUTS: Inputs = {
  hours: '2',
  minutes: '0',
  fps: '25',
  videoSeconds: '10',
  // ILCE-7 RAW (ARW) as measured; JPEG-only shooting is smaller.
  photoMB: '25',
  saveToPc: false,
};

function loadInputs(): Inputs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_INPUTS, ...(JSON.parse(raw) as Partial<Inputs>) };
  } catch {}
  return DEFAULT_INPUTS;
}

function num(s: string): number {
  const v = Number(s);
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m > 0) return `${m} min ${String(sec).padStart(2, '0')} s`;
  return `${sec} s`;
}

function formatInterval(seconds: number): string {
  if (seconds >= 60) return formatDuration(seconds);
  return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(bytes >= 1e8 ? 0 : 1)} MB`;
  return `${Math.round(bytes / 1e3)} kB`;
}

function clockAt(msFromNow: number): string {
  return new Date(Date.now() + msFromNow).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Timelapse planner and runner. Planning: shooting time + video fps + video length give the
 * number of frames and the interval. The camera runs the schedule itself and always stores to
 * the SD card; this tab can also download each frame's JPEG to the PC while it stays open.
 */
export function TimelapsePanel({
  connected,
  timelapse,
  lastJpegBytes,
  transferBps,
  pcSaved,
  pcSkipped,
  pcSeriesActive,
  saveTarget,
  onStart,
  onStop,
  onError,
}: TimelapsePanelProps) {
  const [inputs, setInputs] = useState<Inputs>(loadInputs);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(inputs));
    } catch {}
  }, [inputs]);

  const running = timelapse?.running === true;

  // Tick the countdown once a second while running.
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);

  // Camera clock minus local clock, refreshed with every state update from the camera.
  const clockOffset = useMemo(
    () => (timelapse?.now ? timelapse.now - Date.now() : 0),
    [timelapse],
  );

  const set = (patch: Partial<Inputs>) => setInputs((prev) => ({ ...prev, ...patch }));

  const durationS = num(inputs.hours) * 3600 + num(inputs.minutes) * 60;
  const fps = num(inputs.fps);
  const videoS = num(inputs.videoSeconds);
  const frames = Math.round(fps * videoS);
  const intervalS = frames > 0 ? durationS / frames : 0;
  const sdBytes = frames * num(inputs.photoMB) * 1e6;
  const bps = transferBps ?? MEASURED_BPS;
  const transferS = lastJpegBytes ? lastJpegBytes / bps : null;
  const pcBytes = lastJpegBytes ? frames * lastJpegBytes : null;

  let invalid: string | null = null;
  if (frames < 2) invalid = 'Set fps and video length to at least 2 frames.';
  else if (durationS <= 0) invalid = 'Set the shooting time.';
  else if (intervalS < MIN_INTERVAL_S) invalid = `Interval below ${MIN_INTERVAL_S} s: shorten the video or shoot longer.`;

  const start = async () => {
    if (invalid) return;
    setBusy(true);
    try {
      await onStart(frames, Math.round(intervalS * 1000), inputs.saveToPc);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await onStop();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const tlFrames = timelapse?.frames ?? 0;
  const tlShot = timelapse?.shot ?? 0;
  const tlInterval = (timelapse?.intervalMs ?? 0) / 1000;
  const nextInS = running && timelapse?.nextShotAt ? (timelapse.nextShotAt - (now + clockOffset)) / 1000 : 0;
  const remainingS = running ? Math.max(0, tlFrames - tlShot - 1) * tlInterval + Math.max(0, nextInS) : 0;
  const progressPct = tlFrames > 0 ? (tlShot / tlFrames) * 100 : 0;

  return (
    <section className="panel">
      <div className="panel-header">
        <div className="panel-title">
          <span>Timelapse</span>
          {running && (
            <span className="badge badge-live">
              {tlShot}/{tlFrames}
            </span>
          )}
        </div>
        {running ? (
          <button type="button" className="btn btn-sm btn-danger" onClick={() => void stop()} disabled={busy}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => void start()}
            disabled={!connected || busy || invalid !== null}
            title={invalid ?? `Shoot ${frames} frames every ${formatInterval(intervalS)}`}
          >
            Start
          </button>
        )}
      </div>

      {running ? (
        <div className="timelapse-status">
          <div className="timelapse-progress" aria-hidden="true">
            <span style={{ width: `${progressPct}%` }} />
          </div>
          <dl className="timelapse-grid">
            <dt>Next shot</dt>
            <dd>{nextInS > 0.5 ? `in ${formatDuration(nextInS)}` : 'now'}</dd>
            <dt>Interval</dt>
            <dd>{formatInterval(tlInterval)}</dd>
            <dt>Remaining</dt>
            <dd>
              {formatDuration(remainingS)} (until {clockAt(remainingS * 1000)})
            </dd>
            {(timelapse?.late ?? 0) > 0 && (
              <>
                <dt>Late shots</dt>
                <dd title="Shots that fired after their time because the previous one was still being stored">
                  {timelapse?.late}
                </dd>
              </>
            )}
            {(timelapse?.failed ?? 0) > 0 && (
              <>
                <dt>Not stored</dt>
                <dd className="timelapse-warn">{timelapse?.failed}</dd>
              </>
            )}
            <dt>To PC</dt>
            <dd>
              {pcSeriesActive
                ? `${pcSaved} saved${pcSkipped > 0 ? `, ${pcSkipped} skipped (too slow)` : ''}`
                : 'off (SD card only)'}
            </dd>
          </dl>
        </div>
      ) : (
        <>
          <div className="timelapse-form">
            <label>
              <span>Shooting time</span>
              <span className="timelapse-inline">
                <input
                  type="number"
                  className="input-sm"
                  min={0}
                  value={inputs.hours}
                  onChange={(e) => set({ hours: e.target.value })}
                  aria-label="Shooting time, hours"
                />
                h
                <input
                  type="number"
                  className="input-sm"
                  min={0}
                  max={59}
                  value={inputs.minutes}
                  onChange={(e) => set({ minutes: e.target.value })}
                  aria-label="Shooting time, minutes"
                />
                min
              </span>
            </label>
            <label>
              <span>Video</span>
              <span className="timelapse-inline">
                <select
                  className="input-sm"
                  value={inputs.fps}
                  onChange={(e) => set({ fps: e.target.value })}
                  aria-label="Video frames per second"
                >
                  {FPS_CHOICES.map((f) => (
                    <option key={f} value={String(f)}>
                      {f} fps
                    </option>
                  ))}
                </select>
                ×
                <input
                  type="number"
                  className="input-sm"
                  min={1}
                  value={inputs.videoSeconds}
                  onChange={(e) => set({ videoSeconds: e.target.value })}
                  aria-label="Video length in seconds"
                />
                s
              </span>
            </label>
          </div>

          <dl className="timelapse-grid">
            <dt>Frames</dt>
            <dd>{frames}</dd>
            <dt>Interval</dt>
            <dd className={!invalid && intervalS < TIGHT_INTERVAL_S ? 'timelapse-warn' : undefined}>
              {frames > 0 && durationS > 0 ? formatInterval(intervalS) : '--'}
            </dd>
            <dt>Ends at</dt>
            <dd>{durationS > 0 ? clockAt(durationS * 1000) : '--'}</dd>
            <dt>On SD card</dt>
            <dd>
              ≈ {formatBytes(sdBytes)}
              <span className="timelapse-inline timelapse-photo-size">
                (
                <input
                  type="number"
                  className="input-sm input-xs"
                  min={1}
                  value={inputs.photoMB}
                  onChange={(e) => set({ photoMB: e.target.value })}
                  aria-label="Size of one photo on the card, MB"
                  title="Size of one photo on the card in MB (ILCE-7 RAW measured 25 MB)"
                />
                MB each)
              </span>
            </dd>
          </dl>

          <label className="timelapse-pc">
            <input type="checkbox" checked={inputs.saveToPc} onChange={(e) => set({ saveToPc: e.target.checked })} />
            <span>Also save JPEGs to this PC ({saveTarget})</span>
          </label>
          {inputs.saveToPc && (
            <p className={`timelapse-note ${transferS !== null && transferS > intervalS * 0.8 ? 'timelapse-warn' : ''}`}>
              {transferS === null
                ? 'Take one photo first so the JPEG size is known.'
                : `${formatBytes(lastJpegBytes ?? 0)} per frame, ≈ ${transferS.toFixed(1)} s each at ${formatBytes(bps)}/s${
                    transferS > intervalS * 0.8
                      ? ': faster than Wi‑Fi can keep up, so some frames will be skipped on the PC (the SD card gets all).'
                      : `; ≈ ${formatBytes(pcBytes ?? 0)} in total. Keep this tab open.`
                  }`}
            </p>
          )}
          {invalid && <p className="timelapse-note timelapse-warn">{invalid}</p>}
          {!invalid && intervalS < TIGHT_INTERVAL_S && (
            <p className="timelapse-note timelapse-warn">Short interval: the camera may still be writing the previous photo.</p>
          )}
          {timelapse?.finished && (
            <p className="timelapse-note">
              Last run {timelapse.finished}
              {timelapse.frames ? ` at ${timelapse.shot ?? 0}/${timelapse.frames}` : ''}
              {timelapse.error ? `: ${timelapse.error}` : '.'}
            </p>
          )}
          <p className="timelapse-note">Focus and exposure stay as set; manual exposure avoids flicker.</p>
        </>
      )}
    </section>
  );
}
