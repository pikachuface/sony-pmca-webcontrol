import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CameraClient,
  type CameraEvent,
  type CameraState,
  type CaptureSettings,
  type CaptureSettingsPatch,
  type StoredFile,
  getDefaultCameraUrl,
} from './api/cameraClient';
import {
  isDirectoryPickerSupported,
  pickSaveDirectory,
  readFileFromDirectory,
  saveBlobToDirectory,
  triggerBrowserDownload,
} from './api/localSave';
import { AutoSavePanel, type PcFiles, type SaveDest } from './components/AutoSavePanel';
import { EventsPanel, type LoggedCameraEvent } from './components/EventsPanel';
import { ExposureControl } from './components/ExposureControl';
import { FocusControl } from './components/FocusControl';
import { LiveViewPanel } from './components/LiveViewPanel';
import { PhotoBrowser } from './components/PhotoBrowser';
import { PhotoPreviewModal } from './components/PhotoPreviewModal';
import { QualityPanel } from './components/QualityPanel';
import { RpcInspector } from './components/RpcInspector';
import { TimelapsePanel } from './components/TimelapsePanel';
import { WebcamPanel } from './components/WebcamPanel';

type TabKey = 'control' | 'photos' | 'events' | 'rpc';

/** Webcam: stream only. Photo: shots at the chosen quality. Timelapse: scheduled shots. */
type Mode = 'webcam' | 'photo' | 'timelapse';
type ShootingMode = Exclude<Mode, 'webcam'>;
const MODE_LABELS: Record<Mode, string> = { webcam: 'Webcam', photo: 'Photo', timelapse: 'Timelapse' };
const MODE_HINTS: Record<Mode, string> = {
  webcam: 'Live view stream for OBS, VLC or ffmpeg; nothing is saved',
  photo: 'Photos at the chosen quality, to the SD card and optionally the PC',
  timelapse: 'Scheduled photos with JPEGs for the video',
};

/** Quality remembered per shooting mode and applied when the mode is entered. */
type QualityProfiles = Partial<Record<ShootingMode, CaptureSettingsPatch>>;
const PROFILES_KEY = 'pmca_quality_profiles';
// A timelapse needs JPEGs for the video; RAW is kept for grading.
const DEFAULT_PROFILES: QualityProfiles = { timelapse: { format: 'rawjpeg', jpegQuality: '95' } };

function loadStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    if (v && (allowed as readonly string[]).includes(v)) return v as T;
  } catch {}
  return fallback;
}

function storeValue(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function loadProfiles(): QualityProfiles {
  try {
    const raw = localStorage.getItem(PROFILES_KEY);
    if (raw) return JSON.parse(raw) as QualityProfiles;
  } catch {}
  return DEFAULT_PROFILES;
}

function patchOf(s: CaptureSettings): CaptureSettingsPatch {
  const out: CaptureSettingsPatch = {};
  if (s.format) out.format = s.format;
  if (s.jpegQuality) out.jpegQuality = s.jpegQuality;
  if (s.imageSize) out.imageSize = s.imageSize;
  if (s.aspect) out.aspect = s.aspect;
  return out;
}

function fileExt(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function isJpegFile(f: StoredFile): boolean {
  const ext = fileExt(f.name);
  return ext === 'jpg' || ext === 'jpeg';
}

function applyEventsToState(
  prev: CameraState | null,
  events: CameraEvent[],
): { next: CameraState | null; needFullRefresh: boolean } {
  let needFullRefresh = false;
  if (!prev) {
    return { next: prev, needFullRefresh: true };
  }
  const next: CameraState = { ...prev };
  for (const ev of events) {
    const d = ev.data ?? {};
    switch (ev.type) {
      case 'FocusDrive':
        next.focus = d as CameraState['focus'];
        break;
      case 'ApertureChange':
        next.aperture = d as CameraState['aperture'];
        break;
      case 'ShutterSpeedChange':
        next.shutter = d as CameraState['shutter'];
        break;
      case 'AutoISOSensitivity':
        if (typeof d.iso === 'number') next.autoIso = d.iso;
        break;
      case 'ZoomChange':
        next.zoom = d as CameraState['zoom'];
        break;
      case 'FocalLengthChange':
        if (typeof d.focalLength === 'number') next.focalLength = d.focalLength;
        break;
      case 'PowerZoom':
        if (typeof d.status === 'number') next.powerZoom = d.status;
        break;
      case 'PreviewMagnification':
        next.previewMagnification = d as CameraState['previewMagnification'];
        break;
      case 'CaptureStart':
      case 'CaptureEnd':
        if (typeof d.capturing === 'boolean') next.capturing = d.capturing;
        break;
      case 'Shutter':
        if (typeof d.status === 'number') next.lastShutterStatus = d.status;
        break;
      case 'Timelapse':
        next.timelapse = d as unknown as CameraState['timelapse'];
        break;
      case 'FocusShift':
        next.focusShift = d as unknown as CameraState['focusShift'];
        break;
      case 'AfMode':
        next.afMode = d as unknown as CameraState['afMode'];
        break;
      case 'Faces':
        next.faces = d as unknown as CameraState['faces'];
        break;
      case 'AutoFocusDone':
        if (typeof d.status === 'number') next.afStatus = d.status;
        break;
      case 'StoreImageComplete':
        next.lastStoreImage = d as CameraState['lastStoreImage'];
        break;
      case 'CaptureSettings':
        next.capture = d as CameraState['capture'];
        break;
      case 'OutputCrop':
        next.outputCrop = d as unknown as CameraState['outputCrop'];
        break;
      case 'SettingChanged':
      case 'EquipmentChange':
        needFullRefresh = true;
        break;
    }
    next.seq = Math.max(next.seq ?? 0, ev.seq);
  }
  return { next, needFullRefresh };
}

interface CaptureSeries {
  baseName: string;
  nextIndex: number;
  digits: number;
}

function nextSeriesFileName(series: CaptureSeries): string {
  series.nextIndex += 1;
  return `${series.baseName}_${String(series.nextIndex).padStart(series.digits, '0')}.jpg`;
}

function getEventsClientId(): string {
  const fallback = `ev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const existing = window.sessionStorage.getItem('pmca_ev_cid');
    if (existing) return existing;
    window.sessionStorage.setItem('pmca_ev_cid', fallback);
    return fallback;
  } catch {
    return fallback;
  }
}

export function App() {
  const [urlInput, setUrlInput] = useState<string>(() => getDefaultCameraUrl());
  const [activeUrl, setActiveUrl] = useState<string>(() => getDefaultCameraUrl());
  const client = useMemo(() => new CameraClient(activeUrl), [activeUrl]);

  const [connected, setConnected] = useState(false);
  const [manualDisconnected, setManualDisconnected] = useState(false);
  const [state, setState] = useState<CameraState | null>(null);
  const [events, setEvents] = useState<LoggedCameraEvent[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('control');

  const [mode, setModeState] = useState<Mode>(() => loadStored('pmca_mode', ['webcam', 'photo', 'timelapse'] as const, 'photo'));
  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    storeValue('pmca_mode', m);
  }, []);
  const [saveDest, setSaveDestState] = useState<SaveDest>(() => {
    let legacy: SaveDest = 'sd';
    try {
      if (localStorage.getItem('pmca_autosave_enabled') === 'true') legacy = 'sdpc';
    } catch {}
    return loadStored('pmca_save_dest', ['sd', 'sdpc'] as const, legacy);
  });
  const setSaveDest = useCallback((d: SaveDest) => {
    setSaveDestState(d);
    storeValue('pmca_save_dest', d);
  }, []);
  const [pcFiles, setPcFilesState] = useState<PcFiles>(() => loadStored('pmca_pc_files', ['all', 'jpeg', 'raw'] as const, 'all'));
  const setPcFiles = useCallback((f: PcFiles) => {
    setPcFilesState(f);
    storeValue('pmca_pc_files', f);
  }, []);
  const [profiles, setProfiles] = useState<QualityProfiles>(loadProfiles);
  const [qualityBusy, setQualityBusy] = useState(false);
  const [saveDirName, setSaveDirName] = useState<string | null>(null);
  const [savedCount, setSavedCount] = useState<number>(0);
  const [lastSavedFile, setLastSavedFile] = useState<string | null>(null);
  const [savingStatus, setSavingStatus] = useState<string | null>(null);
  const [previewPhoto, setPreviewPhoto] = useState<{ url: string; name: string } | null>(null);
  /** Size of the last stored file per type ('arw', 'jpg'), for size and transfer estimates. */
  const [lastSizes, setLastSizes] = useState<Record<string, number>>({});
  /** Measured photo download speed (bytes/s), smoothed; null until the first download. */
  const [transferBps, setTransferBps] = useState<number | null>(null);
  const [timelapseSaved, setTimelapseSaved] = useState(0);
  /** Downloads waiting in the save queue. */
  const [queued, setQueued] = useState(0);
  /** This tab saves the running timelapse's frames to the PC. */
  const [timelapsePc, setTimelapsePc] = useState(false);

  const seqRef = useRef<number>(0);
  const dirHandleRef = useRef<FileSystemDirectoryHandle | null>(null);
  const latestSavedRef = useRef<{ blob: Blob; name: string } | null>(null);
  const lastSavedFileRef = useRef<string | null>(null);
  const activeSavePromiseRef = useRef<Promise<void> | null>(null);
  const openedTabUrlsRef = useRef<string[]>([]);
  const activeUrlRef = useRef<string>(activeUrl);
  activeUrlRef.current = activeUrl;

  useEffect(() => {
    return () => {
      for (const u of openedTabUrlsRef.current) {
        URL.revokeObjectURL(u);
      }
      openedTabUrlsRef.current = [];
    };
  }, []);

  // Read by the event handler, which must not be recreated on every change.
  const toPcRef = useRef<{ mode: Mode; dest: SaveDest; files: PcFiles }>({ mode, dest: saveDest, files: pcFiles });
  toPcRef.current = { mode, dest: saveDest, files: pcFiles };

  const refreshState = useCallback(async (): Promise<boolean> => {
    try {
      const s = await client.getState();
      setState(s);
      if (typeof s.seq === 'number') {
        if (s.seq + 10 < seqRef.current) {
          seqRef.current = s.seq;
          handledFilesRef.current.clear();
        } else {
          seqRef.current = Math.max(seqRef.current, s.seq);
        }
      }
      setConnected(true);
      setErrorMsg(null);
      return true;
    } catch (err) {
      setConnected(false);
      setErrorMsg(err instanceof Error ? err.message : String(err));
      return false;
    }
  }, [client]);

  const handledFilesRef = useRef<Set<string>>(new Set());
  // Names a series of captures (e.g. a timelapse) base_0001.jpg, base_0002.jpg, ...
  const captureSeriesRef = useRef<CaptureSeries | null>(null);
  // A name given as a function is taken only once the download succeeded, so a frame that
  // could not be fetched leaves no gap in a numbered series.
  const saveQueueRef = useRef<Array<{ name: string | (() => string); url: string; series?: boolean; resolve?: () => void }>>([]);
  const isProcessingQueueRef = useRef<boolean>(false);

  const processSaveQueue = useCallback(async () => {
    if (isProcessingQueueRef.current) return;
    isProcessingQueueRef.current = true;
    while (saveQueueRef.current.length > 0) {
      const task = saveQueueRef.current.shift();
      if (!task) break;
      setQueued(saveQueueRef.current.length);
      setSavingStatus(typeof task.name === 'string' ? `Saving ${task.name}...` : 'Saving photo...');
      try {
        const started = performance.now();
        const res = await fetch(task.url);
        if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
        const blob = await res.blob();
        const seconds = (performance.now() - started) / 1000;
        if (blob.size > 200_000 && seconds > 0) {
          const bps = blob.size / seconds;
          setTransferBps((prev) => (prev === null ? bps : prev * 0.6 + bps * 0.4));
        }
        const name = typeof task.name === 'function' ? task.name() : task.name;
        if (dirHandleRef.current) {
          await saveBlobToDirectory(dirHandleRef.current, name, blob);
        } else {
          triggerBrowserDownload(name, blob);
        }
        latestSavedRef.current = { blob, name };
        lastSavedFileRef.current = name;
        setSavedCount((c) => c + 1);
        setLastSavedFile(name);
        if (task.series) setTimelapseSaved((n) => n + 1);
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      } finally {
        task.resolve?.();
      }
    }
    setSavingStatus(null);
    isProcessingQueueRef.current = false;
  }, []);

  const queueSavePhoto = useCallback(
    (task: { name: string | (() => string); url: string; series?: boolean }): Promise<void> => {
      const promise = new Promise<void>((resolve) => {
        saveQueueRef.current.push({ ...task, resolve });
        setQueued(saveQueueRef.current.length);
        void processSaveQueue();
      });
      activeSavePromiseRef.current = promise;
      void promise.finally(() => {
        if (activeSavePromiseRef.current === promise) {
          activeSavePromiseRef.current = null;
        }
      });
      return promise;
    },
    [processSaveQueue],
  );

  const handlePickDirectory = useCallback(async () => {
    try {
      const handle = await pickSaveDirectory();
      dirHandleRef.current = handle;
      setSaveDirName(handle.name);
      setErrorMsg(null);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, []);

  /**
   * A shot was stored on the card. Records its file sizes and, when this tab saves to the PC,
   * queues the full-quality files from the card: the JPEG for a timelapse series, or the
   * chosen types (camera file names) in Photo mode.
   */
  const handleStoredEvent = useCallback(
    async (ev: CameraEvent) => {
      if (ev.type !== 'StoreImageComplete') return;
      const dedupKey = `store_${ev.seq}`;
      if (handledFilesRef.current.has(dedupKey)) return;
      if (handledFilesRef.current.size > 500) {
        handledFilesRef.current.clear();
      }
      handledFilesRef.current.add(dedupKey);

      const data = ev.data ?? {};
      let files: StoredFile[] = Array.isArray(data.files) ? (data.files as StoredFile[]) : [];
      if (files.length === 0) {
        // The camera could not resolve the file names: take the newest shot on the card.
        try {
          files = await client.lastShotFiles();
        } catch {
          files = [];
        }
      }
      if (files.length > 0) {
        setLastSizes((prev) => {
          const next = { ...prev };
          for (const f of files) {
            const ext = fileExt(f.name) === 'jpeg' ? 'jpg' : fileExt(f.name);
            if (f.size > 0) next[ext] = f.size;
          }
          return next;
        });
      }

      const fresh = files.filter((f) => !handledFilesRef.current.has(`file_${f.path}`));
      const take = (f: StoredFile) => handledFilesRef.current.add(`file_${f.path}`);

      const series = captureSeriesRef.current;
      if (series) {
        const jpg = fresh.find(isJpegFile);
        if (!jpg) return;
        take(jpg);
        void queueSavePhoto({
          name: () => nextSeriesFileName(series),
          url: client.photoDownloadUrl(jpg.path),
          series: true,
        });
        return;
      }

      const pc = toPcRef.current;
      if (pc.mode !== 'photo' || pc.dest !== 'sdpc') return;
      for (const f of fresh) {
        const jpeg = isJpegFile(f);
        if ((pc.files === 'jpeg' && !jpeg) || (pc.files === 'raw' && jpeg)) continue;
        take(f);
        void queueSavePhoto({ name: f.name, url: client.photoDownloadUrl(f.path) });
      }
    },
    [client, queueSavePhoto],
  );

  const eventsCidRef = useRef<string>(getEventsClientId());

  const startTimelapse = useCallback(
    async (frames: number, intervalMs: number, saveToPc: boolean) => {
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      captureSeriesRef.current = saveToPc
        ? {
            baseName: `timelapse_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`,
            nextIndex: 0,
            digits: Math.max(4, String(frames).length),
          }
        : null;
      setTimelapsePc(saveToPc);
      setTimelapseSaved(0);
      try {
        const tl = await client.startTimelapse(frames, intervalMs);
        setState((prev) => (prev ? { ...prev, timelapse: tl } : prev));
      } catch (err) {
        captureSeriesRef.current = null;
        setTimelapsePc(false);
        throw err;
      }
    },
    [client],
  );

  const stopTimelapse = useCallback(async () => {
    const tl = await client.stopTimelapse();
    setState((prev) => (prev ? { ...prev, timelapse: tl } : prev));
  }, [client]);

  // The PC series ends with the camera run; queued downloads keep their series for naming.
  const timelapseRunning = state?.timelapse?.running === true;
  useEffect(() => {
    if (!timelapseRunning) {
      captureSeriesRef.current = null;
      setTimelapsePc(false);
    } else {
      // A run started elsewhere (or before a reload) shows up in Timelapse mode.
      setMode('timelapse');
    }
  }, [timelapseRunning, setMode]);

  /** Writes quality to the camera; by default remembers the result for the current mode. */
  const applyQuality = useCallback(
    async (patch: CaptureSettingsPatch, remember = true) => {
      setQualityBusy(true);
      try {
        const s = await client.setCaptureSettings(patch);
        setState((prev) => (prev ? { ...prev, capture: s } : prev));
        const m = toPcRef.current.mode;
        if (remember && m !== 'webcam') {
          setProfiles((prev) => {
            const next = { ...prev, [m]: patchOf(s) };
            storeValue(PROFILES_KEY, JSON.stringify(next));
            return next;
          });
        }
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      } finally {
        setQualityBusy(false);
      }
    },
    [client],
  );

  // Entering Photo or Timelapse mode restores that mode's quality (once per mode and camera).
  const capture = state?.capture;
  const appliedProfileRef = useRef('');
  useEffect(() => {
    if (!connected || !capture?.format || mode === 'webcam' || timelapseRunning) return;
    const profile = profiles[mode];
    if (!profile) return;
    const key = `${activeUrl}|${mode}`;
    if (appliedProfileRef.current === key) return;
    appliedProfileRef.current = key;
    const differs = (Object.keys(profile) as (keyof CaptureSettingsPatch)[]).some(
      (k) => profile[k] !== undefined && capture[k] !== profile[k],
    );
    if (!differs) return;
    // Keep what the camera had for the other mode, so switching back restores it.
    const other: ShootingMode = mode === 'photo' ? 'timelapse' : 'photo';
    if (!profiles[other]) {
      setProfiles((prev) => {
        const next = { ...prev, [other]: patchOf(capture) };
        storeValue(PROFILES_KEY, JSON.stringify(next));
        return next;
      });
    }
    void applyQuality(profile, false);
  }, [connected, capture, mode, profiles, timelapseRunning, activeUrl, applyQuality]);

  useEffect(() => {
    const onPageHide = () => {
      client.closeEventsStream(eventsCidRef.current);
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [client]);

  // Initial state fetch + SSE /api/events/stream (kept open across tab switches so captures are never missed)
  useEffect(() => {
    if (manualDisconnected) {
      setConnected(false);
      return;
    }
    let cancelled = false;
    let eventSource: EventSource | null = null;
    let retryTimer: number | null = null;

    const scheduleRetry = () => {
      if (cancelled || retryTimer !== null) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void start();
      }, 1500);
    };

    const handleIncomingEvents = async (incoming: CameraEvent[]) => {
      if (cancelled || incoming.length === 0) return;
      const now = Date.now();
      // Faces arrive several times a second while face detection is on; keep them out of the log.
      const logged: LoggedCameraEvent[] = incoming
        .filter((ev) => ev.type !== 'Faces')
        .map((ev) => ({
          ...ev,
          receivedAt: now,
        }));
      if (logged.length > 0) {
        setEvents((prev) => [...logged.slice().reverse(), ...prev].slice(0, 200));
      }
      let needFullRefresh = false;
      setState((prev) => {
        const applied = applyEventsToState(prev, incoming);
        needFullRefresh = applied.needFullRefresh;
        return applied.next;
      });
      for (const ev of incoming) {
        if (ev.type === 'StoreImageComplete') {
          void handleStoredEvent(ev);
        }
      }
      if (needFullRefresh) {
        await refreshState();
      }
    };

    const start = async () => {
      const ok = await refreshState();
      if (cancelled) return;
      if (!ok) {
        scheduleRetry();
        return;
      }

      const es = new EventSource(client.eventsStreamUrl(seqRef.current, eventsCidRef.current));
      eventSource = es;

      es.onopen = () => {
        if (cancelled) return;
        setConnected(true);
      };

      es.onmessage = (msg) => {
        if (cancelled || !msg.data) return;
        try {
          const ev = JSON.parse(msg.data) as CameraEvent;
          if (typeof ev.seq === 'number' && ev.seq > seqRef.current) {
            seqRef.current = ev.seq;
          }
          setConnected(true);
          void handleIncomingEvents([ev]);
        } catch {
          // Ignore malformed event payloads
        }
      };

      es.onerror = () => {
        if (cancelled) return;
        setConnected(false);
        es.close();
        if (eventSource === es) {
          eventSource = null;
        }
        scheduleRetry();
      };
    };

    void start();

    return () => {
      cancelled = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
      if (eventSource) {
        eventSource.close();
      }
      client.closeEventsStream(eventsCidRef.current);
    };
  }, [client, handleStoredEvent, refreshState, manualDisconnected]);

  const handleConnectSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (connected) {
      setManualDisconnected(true);
      setConnected(false);
      setState(null);
      return;
    }
    const cleaned = urlInput.trim().replace(/\/+$/, '');
    if (!cleaned) return;
    setManualDisconnected(false);
    client.setBaseUrl(cleaned);
    setActiveUrl(cleaned);
    seqRef.current = 0;
  };

  const handleCapture = async () => {
    try {
      await client.takePicture();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const openBlobInNewTab = useCallback(
    async (loader: () => Promise<{ blob: Blob; name: string }>) => {
      const popup = window.open('', '_blank');
      if (popup) {
        try {
          popup.document.open();
          popup.document.write(
            '<!doctype html><title>Loading photo...</title><body style="margin:0;background:#0d1117;color:#c9d1d9;display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui,sans-serif">Loading photo...</body>',
          );
          popup.document.close();
        } catch {
          // ignore cross-context write issues
        }
      }
      try {
        const { blob, name } = await loader();
        const url = URL.createObjectURL(blob);
        openedTabUrlsRef.current.push(url);
        if (openedTabUrlsRef.current.length > 10) {
          const old = openedTabUrlsRef.current.shift();
          if (old) URL.revokeObjectURL(old);
        }
        if (popup && !popup.closed) {
          popup.location.replace(url);
        } else {
          setPreviewPhoto({ url, name });
        }
      } catch (err) {
        if (popup && !popup.closed) {
          popup.close();
        }
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    },
    [],
  );

  const handleOpenSavedPhoto = useCallback(() => {
    void openBlobInNewTab(async () => {
      if (activeSavePromiseRef.current) {
        await activeSavePromiseRef.current;
      }
      const name = lastSavedFileRef.current;
      if (dirHandleRef.current && name) {
        const file = await readFileFromDirectory(dirHandleRef.current, name);
        return { blob: file, name };
      }
      if (latestSavedRef.current) {
        return { blob: latestSavedRef.current.blob, name: latestSavedRef.current.name };
      }
      throw new Error('No local auto-saved photo in this session yet');
    });
  }, [openBlobInNewTab]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className={`status-dot ${connected ? 'dot-ok' : 'dot-off'}`} />
          <span className="brand-title">Sony PMCA WebControl</span>
        </div>

        <nav className="tabs" aria-label="Primary views">
          {(
            [
              { id: 'control', label: 'Camera Control' },
              { id: 'photos', label: 'Photos' },
              { id: 'events', label: 'Events' },
              { id: 'rpc', label: 'RPC Inspector' },
            ] as const
          ).map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className={`tab-btn ${tab === id ? 'tab-active' : ''}`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>

        {!__CAMERA_EMBEDDED__ && (
          <form className="connect-form" onSubmit={handleConnectSubmit}>
            <input
              type="text"
              className="input-text url-input"
              value={urlInput}
              disabled={connected}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="http://192.168.0.250:8080"
              aria-label="Camera base URL"
              title="Camera HTTP server URL"
            />
            <button
              type="submit"
              className={`btn btn-sm ${connected ? 'btn-danger' : 'btn-primary'}`}
              title={connected ? 'Disconnect from camera' : 'Connect to camera'}
            >
              {connected ? 'Disconnect' : 'Connect'}
            </button>
          </form>
        )}
      </header>

      {errorMsg && (
        <div className="error-banner">
          <span>{errorMsg}</span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setErrorMsg(null)}
            aria-label="Dismiss error"
          >
            Dismiss
          </button>
        </div>
      )}

      <main className="main-content">
        {tab === 'control' && (
          <div className="control-layout">
            <LiveViewPanel
              client={client}
              connected={connected}
              onCapture={handleCapture}
              capturing={Boolean(state?.capturing)}
              faces={state?.afMode?.faces ? state?.faces?.faces : undefined}
              afMode={state?.afMode}
              afLock={state?.afStatus}
              onError={setErrorMsg}
            />
            <div className="side-column">
              <div className="mode-bar" role="group" aria-label="Mode">
                {(Object.keys(MODE_LABELS) as Mode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`mode-btn ${mode === m ? 'is-active' : ''}`}
                    aria-pressed={mode === m}
                    title={MODE_HINTS[m]}
                    disabled={timelapseRunning && m !== 'timelapse'}
                    onClick={() => setMode(m)}
                  >
                    {MODE_LABELS[m]}
                  </button>
                ))}
              </div>
              {mode === 'webcam' && (
                <WebcamPanel client={client} connected={connected} cropEnabled={state?.outputCrop?.enabled === true} />
              )}
              <ExposureControl
                client={client}
                state={state}
                connected={connected}
                onError={setErrorMsg}
              />
              <FocusControl
                client={client}
                connected={connected}
                focusShift={state?.focusShift}
                afMode={state?.afMode}
                afStatus={state?.afStatus}
                faceCount={state?.faces?.faces?.length ?? 0}
                onError={setErrorMsg}
              />
              {mode !== 'webcam' && (
                <QualityPanel
                  connected={connected}
                  settings={state?.capture}
                  modeLabel={MODE_LABELS[mode]}
                  lastSizes={lastSizes}
                  busy={qualityBusy}
                  locked={timelapseRunning}
                  onChange={(patch) => void applyQuality(patch)}
                />
              )}
              {mode === 'timelapse' && (
                <TimelapsePanel
                  connected={connected}
                  timelapse={state?.timelapse}
                  format={state?.capture?.format}
                  jpegBytes={lastSizes.jpg ?? null}
                  rawBytes={lastSizes.arw ?? null}
                  transferBps={transferBps}
                  pcSaved={timelapseSaved}
                  pcQueued={timelapsePc ? queued : 0}
                  pcSeriesActive={timelapsePc}
                  saveTarget={saveDirName ? `folder ${saveDirName}` : 'browser downloads'}
                  onStart={startTimelapse}
                  onStop={stopTimelapse}
                  onUseJpeg={() => void applyQuality({ format: 'rawjpeg' })}
                  onError={setErrorMsg}
                />
              )}
              {mode === 'photo' && (
                <AutoSavePanel
                  dest={saveDest}
                  onDestChange={(d) => {
                    setSaveDest(d);
                    if (d === 'sdpc' && isDirectoryPickerSupported() && !dirHandleRef.current) {
                      void handlePickDirectory();
                    }
                  }}
                  pcFiles={pcFiles}
                  onPcFilesChange={setPcFiles}
                  format={state?.capture?.format}
                  dirName={saveDirName}
                  onPickDirectory={() => void handlePickDirectory()}
                  savedCount={savedCount}
                  queued={queued}
                  lastSavedFile={lastSavedFile}
                  savingStatus={savingStatus}
                  connected={connected}
                  getLatestPhotoUrl={(inline = false) => client.latestPhotoUrl(Date.now(), inline)}
                  onOpenSavedPhoto={handleOpenSavedPhoto}
                />
              )}
            </div>
          </div>
        )}

        {tab === 'photos' && (
          <PhotoBrowser
            client={client}
            connected={connected}
            onError={setErrorMsg}
          />
        )}

        {tab === 'events' && (
          <EventsPanel events={events} onClear={() => setEvents([])} />
        )}

        {tab === 'rpc' && <RpcInspector client={client} connected={connected} />}
      </main>

      <PhotoPreviewModal
        url={previewPhoto?.url ?? null}
        title={previewPhoto?.name ?? 'Latest Capture'}
        onClose={() => setPreviewPhoto(null)}
      />
    </div>
  );
}
