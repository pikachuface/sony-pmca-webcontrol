import { useEffect, useRef, useState } from 'react';
import type { CameraClient } from '../api/cameraClient';
import { CropOverlay } from './CropOverlay';
import { clamp, containBox, rectDisplayToImage, rectImageToDisplay, type NRect } from './viewGeometry';

const MAX_PREVIEW_ZOOM = 4;
/** Pointer travel (px) after which a press on the zoomed view pans instead of autofocusing. */
const PAN_THRESHOLD_PX = 4;

interface LiveViewPanelProps {
  client: CameraClient;
  connected: boolean;
  onCapture: () => void;
  capturing: boolean;
  onError?: (msg: string | null) => void;
}

function getLiveViewClientId(): string {
  const fallback = `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const existing = window.sessionStorage.getItem('pmca_lv_cid');
    if (existing) return existing;
    window.sessionStorage.setItem('pmca_lv_cid', fallback);
    return fallback;
  } catch {
    return fallback;
  }
}

export function LiveViewPanel({
  client,
  connected,
  onCapture,
  capturing,
  onError,
}: LiveViewPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const histCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const [streaming, setStreaming] = useState(true);
  const [pageVisible, setPageVisible] = useState<boolean>(() =>
    typeof document === 'undefined' ? true : !document.hidden,
  );
  const [showGrid, setShowGrid] = useState(true);
  const [peaking, setPeaking] = useState(false);
  const [showHistogram, setShowHistogram] = useState(false);
  const [afStatus, setAfStatus] = useState<'idle' | 'focusing' | 'ok' | 'fail'>('idle');
  const [focusPoint, setFocusPoint] = useState<{ x: number; y: number } | null>(null);
  const [rotationDeg, setRotationDeg] = useState<0 | 90 | 180 | 270>(() => {
    try {
      const saved = Number(localStorage.getItem('pmca_lv_rotation'));
      if (saved === 0 || saved === 90 || saved === 180 || saved === 270) return saved;
    } catch {}
    return 0;
  });

  const [fps, setFps] = useState<number>(0);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [lvMode, setLvMode] = useState<'mjpeg' | 'jpg'>('mjpeg');

  const focusPointRef = useRef<{ x: number; y: number } | null>(null);
  focusPointRef.current = focusPoint;
  const afStatusRef = useRef<'idle' | 'focusing' | 'ok' | 'fail'>('idle');
  afStatusRef.current = afStatus;
  const liveViewCidRef = useRef<string>(getLiveViewClientId());
  const afTimerRef = useRef<number | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [stageSize, setStageSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [frameDims, setFrameDims] = useState<{ w: number; h: number }>({ w: 640, h: 424 });
  const [previewZoom, setPreviewZoom] = useState(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const panDragRef = useRef<{ pointerId: number; lastX: number; lastY: number; moved: number } | null>(null);
  const suppressClickRef = useRef(false);
  // Output crop in unrotated image coordinates, as the camera applies it; null = no crop.
  const [cropImage, setCropImage] = useState<NRect | null>(null);
  // Crop while it is being dragged, in display coordinates.
  const [cropDraft, setCropDraft] = useState<NRect | null>(null);
  const [cropEditing, setCropEditing] = useState(false);
  const [framed, setFramed] = useState(false);
  const [outputCopied, setOutputCopied] = useState(false);
  const outputUrlRef = useRef<HTMLInputElement | null>(null);

  const clearAfTimer = () => {
    if (afTimerRef.current !== null) {
      window.clearTimeout(afTimerRef.current);
      afTimerRef.current = null;
    }
  };

  const scheduleAfDismiss = (delayMs = 2000) => {
    clearAfTimer();
    afTimerRef.current = window.setTimeout(() => {
      setAfStatus('idle');
      setFocusPoint(null);
      afTimerRef.current = null;
    }, delayMs);
  };

  useEffect(() => {
    return () => {
      if (afTimerRef.current !== null) {
        window.clearTimeout(afTimerRef.current);
      }
    };
  }, []);

  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === stageRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void stageRef.current?.requestFullscreen().catch((err) => {
        onError?.(err instanceof Error ? err.message : String(err));
      });
    }
  };
  // Keep overlay flags in refs so toggling them doesn't reconnect the MJPEG stream
  const peakingRef = useRef(peaking);
  peakingRef.current = peaking;
  const showHistogramRef = useRef(showHistogram);
  showHistogramRef.current = showHistogram;
  const rotationRef = useRef<0 | 90 | 180 | 270>(rotationDeg);
  rotationRef.current = rotationDeg;

  const rotateBy = (delta: 90 | 270) => {
    setRotationDeg((prev) => {
      const next = ((prev + delta) % 360) as 0 | 90 | 180 | 270;
      try {
        localStorage.setItem('pmca_lv_rotation', String(next));
      } catch {}
      return next;
    });
    clearAfTimer();
    setAfStatus('idle');
    setFocusPoint(null);
  };

  useEffect(() => {
    const onVisibilityChange = () => {
      setPageVisible(!document.hidden);
    };
    const onPageHide = () => {
      client.closeLiveView(liveViewCidRef.current);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [client]);

  useEffect(() => {
    if (!connected || !streaming || !pageVisible) {
      setFps(0);
      return;
    }

    let cancelled = false;
    let retryTimer: number | undefined;
    let activeController: AbortController | null = null;
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let frameCount = 0;
    let lastFpsTime = performance.now();

    let pendingBlob: Blob | null = null;
    let isRendering = false;

    const renderLoop = async () => {
      if (isRendering || cancelled) return;
      isRendering = true;
      try {
        while (!cancelled && pendingBlob) {
          const blob = pendingBlob;
          pendingBlob = null;

          const bitmap = await createImageBitmap(blob);
          if (cancelled) {
            bitmap.close();
            break;
          }

          const canvas = canvasRef.current;
          if (canvas) {
            const deg = rotationRef.current;
            const srcW = bitmap.width || 640;
            const srcH = bitmap.height || 480;
            const targetW = deg % 180 !== 0 ? srcH : srcW;
            const targetH = deg % 180 !== 0 ? srcW : srcH;
            if (canvas.width !== targetW || canvas.height !== targetH) {
              canvas.width = targetW;
              canvas.height = targetH;
              setFrameDims({ w: targetW, h: targetH });
            }
            const needPixels = peakingRef.current || showHistogramRef.current;
            const ctx = canvas.getContext('2d', { willReadFrequently: needPixels });
            if (ctx) {
              if (deg === 0) {
                ctx.drawImage(bitmap, 0, 0, srcW, srcH);
              } else {
                ctx.save();
                ctx.translate(targetW / 2, targetH / 2);
                ctx.rotate((deg * Math.PI) / 180);
                ctx.drawImage(bitmap, -srcW / 2, -srcH / 2, srcW, srcH);
                ctx.restore();
              }

              if (needPixels) {
                const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const data = imgData.data;

                if (showHistogramRef.current && histCanvasRef.current) {
                  drawHistogram(histCanvasRef.current, data);
                }

                if (peakingRef.current) {
                  applyFocusPeaking(data, canvas.width, canvas.height);
                  ctx.putImageData(imgData, 0, 0);
                }
              }

              // Draw AF target box on main canvas
              if (afStatusRef.current !== 'idle' && focusPointRef.current) {
                const label =
                  afStatusRef.current === 'focusing'
                    ? 'AF...'
                    : afStatusRef.current === 'ok'
                      ? 'AF OK'
                      : 'AF Fail';
                drawFocusBox(
                  ctx,
                  focusPointRef.current.x,
                  focusPointRef.current.y,
                  72,
                  72,
                  label,
                );
              }

            }
          }
          bitmap.close();

          frameCount += 1;
          const now = performance.now();
          if (now - lastFpsTime >= 1000) {
            setFps(Math.round((frameCount * 1000) / (now - lastFpsTime)));
            frameCount = 0;
            lastFpsTime = now;
          }
        }
      } catch {
        // Ignore transient decode errors on partial/aborted frames
      } finally {
        isRendering = false;
      }
    };

    const startStream = async () => {
      if (cancelled) return;
      activeController = new AbortController();
      try {
        const res = await fetch(client.liveViewMjpegUrl(liveViewCidRef.current), {
          signal: activeController.signal,
          cache: 'no-store',
        });

        if (res.status === 503) {
          setFrameError('LiveView busy (too many clients)');
          setFps(0);
          setStreaming(false);
          return;
        }
        if (!res.ok || !res.body) {
          throw new Error(`HTTP ${res.status}`);
        }

        setFrameError(null);
        const reader = res.body.getReader();
        activeReader = reader;
        let buffer = new Uint8Array(0);
        const decoder = new TextDecoder('ascii');

        while (!cancelled) {
          const { value, done } = await reader.read();
          if (done || cancelled) break;
          if (!value || value.length === 0) continue;

          const merged = new Uint8Array(buffer.length + value.length);
          merged.set(buffer);
          merged.set(value, buffer.length);
          buffer = merged;

          // Parse complete multipart/x-mixed-replace frames by Content-Length
          while (true) {
            const headerEnd = findHeaderEnd(buffer);
            if (headerEnd === -1) break;

            const headerText = decoder.decode(buffer.subarray(0, headerEnd));
            const match = /Content-Length:\s*(\d+)/i.exec(headerText);
            if (!match) {
              buffer = buffer.subarray(headerEnd + 4);
              continue;
            }
            const contentLen = Number(match[1]);
            const bodyStart = headerEnd + 4;
            if (buffer.length < bodyStart + contentLen) {
              break;
            }

            // Copy frame slice & overwrite any un-decoded previous frame (zero backlog)
            const jpegCopy = buffer.slice(bodyStart, bodyStart + contentLen);
            buffer = buffer.subarray(bodyStart + contentLen);
            pendingBlob = new Blob([jpegCopy], { type: 'image/jpeg' });
            void renderLoop();
          }
        }
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) {
          return;
        }
        setFrameError('LiveView stream unavailable');
        setFps(0);
        retryTimer = window.setTimeout(() => void startStream(), 1500);
      }
    };

    const startJpgLoop = async () => {
      while (!cancelled) {
        activeController = new AbortController();
        try {
          const res = await fetch(client.liveViewJpgUrl(), {
            signal: activeController.signal,
            cache: 'no-store',
          });
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }
          const blob = await res.blob();
          if (cancelled) break;
          setFrameError(null);
          pendingBlob = blob;
          await renderLoop();
        } catch (err) {
          if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) {
            return;
          }
          setFrameError('LiveView JPEG unavailable');
          setFps(0);
          await new Promise<void>((resolve) => {
            retryTimer = window.setTimeout(resolve, 1500);
          });
        }
      }
    };

    if (lvMode === 'jpg') {
      void startJpgLoop();
    } else {
      void startStream();
    }

    return () => {
      cancelled = true;
      void activeReader?.cancel().catch(() => {});
      activeController?.abort();
      if (lvMode === 'mjpeg') {
        client.closeLiveView(liveViewCidRef.current);
      }
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [client, connected, streaming, pageVisible, lvMode]);

  const handleCanvasClick = async (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (!connected || cropEditing) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const imgRatio = canvas.width / canvas.height;
    const boxRatio = rect.width / rect.height;
    let renderWidth = rect.width;
    let renderHeight = rect.height;
    let offsetX = 0;
    let offsetY = 0;

    if (boxRatio > imgRatio) {
      renderWidth = rect.height * imgRatio;
      offsetX = (rect.width - renderWidth) / 2;
    } else {
      renderHeight = rect.width / imgRatio;
      offsetY = (rect.height - renderHeight) / 2;
    }

    const relX = e.clientX - rect.left - offsetX;
    const relY = e.clientY - rect.top - offsetY;

    if (relX < 0 || relX > renderWidth || relY < 0 || relY > renderHeight) {
      return;
    }

    const dispX = relX / renderWidth;
    const dispY = relY / renderHeight;
    const clickX = Math.round(dispX * canvas.width);
    const clickY = Math.round(dispY * canvas.height);

    let normX = dispX;
    let normY = dispY;
    if (rotationDeg === 90) {
      normX = dispY;
      normY = 1 - dispX;
    } else if (rotationDeg === 180) {
      normX = 1 - dispX;
      normY = 1 - dispY;
    } else if (rotationDeg === 270) {
      normX = 1 - dispY;
      normY = dispX;
    }

    clearAfTimer();
    setFocusPoint({ x: clickX, y: clickY });
    setAfStatus('focusing');
    try {
      const res = await client.autoFocusAt(normX, normY);
      if (!res.superseded) {
        setAfStatus(res.focused ? 'ok' : 'fail');
        scheduleAfDismiss(2000);
      }
    } catch (err) {
      setAfStatus('fail');
      scheduleAfDismiss(2000);
      onError?.(err instanceof Error ? err.message : String(err));
    }
  };

  // Stage size drives the contain box and the zoom/frame transform.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const update = () => setStageSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The output crop lives in the camera; pick it up on (re)connect.
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    client
      .getOutputCrop()
      .then((c) => {
        if (!cancelled) setCropImage(c.enabled ? { x: c.x, y: c.y, w: c.w, h: c.h } : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, connected]);

  const box = containBox(stageSize.w, stageSize.h, frameDims.w, frameDims.h);
  const cropDisplay = cropDraft ?? (cropImage ? rectImageToDisplay(cropImage, rotationDeg) : null);
  const isFramed = framed && cropImage !== null;

  // View transform (origin top-left): Frame fits the crop to the stage, otherwise preview zoom + pan.
  let viewScale = 1;
  let viewX = 0;
  let viewY = 0;
  if (isFramed && cropDisplay && cropDisplay.w > 0 && cropDisplay.h > 0 && box.width > 0) {
    const cw = cropDisplay.w * box.width;
    const ch = cropDisplay.h * box.height;
    viewScale = Math.min(stageSize.w / cw, stageSize.h / ch);
    const cx = box.left + (cropDisplay.x + cropDisplay.w / 2) * box.width;
    const cy = box.top + (cropDisplay.y + cropDisplay.h / 2) * box.height;
    viewX = stageSize.w / 2 - viewScale * cx;
    viewY = stageSize.h / 2 - viewScale * cy;
  } else if (previewZoom > 1) {
    viewScale = previewZoom;
    viewX = (stageSize.w - stageSize.w * viewScale) / 2 + pan.x;
    viewY = (stageSize.h - stageSize.h * viewScale) / 2 + pan.y;
  }
  const viewTransform =
    viewScale === 1 && viewX === 0 && viewY === 0
      ? undefined
      : `translate(${viewX}px, ${viewY}px) scale(${viewScale})`;

  // Rule-of-thirds grid in stage pixels: over the crop when there is one (that is the output
  // composition), else over the whole image. Drawn outside the transformed viewport so the
  // lines stay 1px sharp at any zoom.
  const gridBase =
    cropDisplay && cropDisplay.w > 0 && cropDisplay.h > 0
      ? {
          left: box.left + cropDisplay.x * box.width,
          top: box.top + cropDisplay.y * box.height,
          width: cropDisplay.w * box.width,
          height: cropDisplay.h * box.height,
        }
      : box;
  const gridRect = {
    left: viewX + viewScale * gridBase.left,
    top: viewY + viewScale * gridBase.top,
    width: viewScale * gridBase.width,
    height: viewScale * gridBase.height,
  };

  const clampPan = (x: number, y: number, zoom: number) => {
    const maxX = (stageSize.w * zoom - stageSize.w) / 2;
    const maxY = (stageSize.h * zoom - stageSize.h) / 2;
    return { x: clamp(x, -maxX, maxX), y: clamp(y, -maxY, maxY) };
  };

  const changeZoom = (zoom: number) => {
    setPreviewZoom(zoom);
    setPan((p) => (zoom <= 1 ? { x: 0, y: 0 } : clampPan(p.x, p.y, zoom)));
  };

  const onViewPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    suppressClickRef.current = false;
    if (previewZoom <= 1 || isFramed || cropEditing || e.button !== 0) return;
    panDragRef.current = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY, moved: 0 };
  };

  const onViewPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = panDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.lastX;
    const dy = e.clientY - drag.lastY;
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    if (drag.moved > PAN_THRESHOLD_PX) {
      viewportRef.current?.setPointerCapture(e.pointerId);
      setPan((p) => clampPan(p.x + dx, p.y + dy, previewZoom));
    }
  };

  const onViewPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = panDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    panDragRef.current = null;
    if (drag.moved > PAN_THRESHOLD_PX) suppressClickRef.current = true;
  };

  const commitCrop = (displayRect: NRect) => {
    const img = rectDisplayToImage(displayRect, rotationDeg);
    setCropImage(img);
    setCropDraft(null);
    void client.setOutputCrop(img).catch((err) => {
      onError?.(err instanceof Error ? err.message : String(err));
    });
  };

  const clearCrop = () => {
    setCropImage(null);
    setCropDraft(null);
    setCropEditing(false);
    setFramed(false);
    void client.setOutputCrop(null).catch((err) => {
      onError?.(err instanceof Error ? err.message : String(err));
    });
  };

  const copyOutputUrl = async () => {
    const url = client.outputMjpegUrl();
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // The Clipboard API needs a secure context; the camera serves plain HTTP.
      outputUrlRef.current?.select();
      document.execCommand('copy');
    }
    setOutputCopied(true);
    window.setTimeout(() => setOutputCopied(false), 1500);
  };

  return (
    <section className="panel liveview-panel">
      <div className="panel-header">
        <div className="panel-title">
          <span>LiveView</span>
          <span className="badge">{streaming && pageVisible && connected ? `${fps} FPS` : 'PAUSED'}</span>
          {rotationDeg !== 0 && <span className="badge">{rotationDeg}°</span>}
        </div>
        <div className="toolbar-row">
          <button
            type="button"
            className={`btn btn-sm ${showGrid ? 'btn-active' : ''}`}
            onClick={() => setShowGrid((g) => !g)}
            title="Toggle rule-of-thirds composition grid"
            aria-label="Toggle rule-of-thirds composition grid"
          >
            Grid
          </button>
          <button
            type="button"
            className={`btn btn-sm ${peaking ? 'btn-active' : ''}`}
            onClick={() => setPeaking((p) => !p)}
            title="Toggle focus peaking highlight overlay"
            aria-label="Toggle focus peaking highlight overlay"
          >
            Peaking
          </button>
          <button
            type="button"
            className={`btn btn-sm ${showHistogram ? 'btn-active' : ''}`}
            onClick={() => setShowHistogram((h) => !h)}
            title="Toggle live luminance histogram overlay"
            aria-label="Toggle live luminance histogram overlay"
          >
            Hist
          </button>
          <button
            type="button"
            className={`btn btn-sm ${streaming ? 'btn-active' : ''}`}
            onClick={() => {
              setFrameError(null);
              setStreaming((s) => !s);
            }}
            aria-pressed={streaming}
            title={streaming ? 'Pause LiveView stream' : 'Resume LiveView stream'}
            aria-label={streaming ? 'Pause LiveView stream' : 'Resume LiveView stream'}
          >
            {streaming ? (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <rect x="6" y="4" width="4" height="16" rx="1" />
                <rect x="14" y="4" width="4" height="16" rx="1" />
              </svg>
            ) : (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <polygon points="6 4 20 12 6 20 6 4" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className={`btn btn-sm ${lvMode === 'jpg' ? 'btn-active' : ''}`}
            onClick={() => {
              setFrameError(null);
              setLvMode((m) => (m === 'mjpeg' ? 'jpg' : 'mjpeg'));
            }}
            aria-pressed={lvMode === 'jpg'}
            title={
              lvMode === 'jpg'
                ? 'Single-frame JPEG mode (click to switch to MJPEG stream)'
                : 'MJPEG stream mode (click to switch to single-frame JPEG)'
            }
            aria-label={
              lvMode === 'jpg'
                ? 'Single-frame JPEG mode, switch to MJPEG stream'
                : 'MJPEG stream mode, switch to single-frame JPEG'
            }
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <circle cx="8.5" cy="10" r="1.5" />
              <path d="M21 16l-5-5-6 6-3-3-4 4" />
            </svg>
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => rotateBy(270)}
            title="Rotate Left 90°"
            aria-label="Rotate Left 90°"
          >
            ↺
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => rotateBy(90)}
            title="Rotate Right 90°"
            aria-label="Rotate Right 90°"
          >
            ↻
          </button>
          <button
            type="button"
            className={`btn btn-sm ${cropEditing ? 'btn-active' : ''}`}
            disabled={!connected || isFramed}
            onClick={() => setCropEditing((v) => !v)}
            title={cropEditing ? 'Finish editing the crop' : 'Crop the output: drag a rectangle on the image'}
            aria-pressed={cropEditing}
          >
            ✂ Crop
          </button>
          {cropImage && (
            <>
              <button
                type="button"
                className={`btn btn-sm ${isFramed ? 'btn-active' : ''}`}
                onClick={() => {
                  setCropEditing(false);
                  setFramed((f) => !f);
                }}
                title={isFramed ? 'Show the whole image' : 'Zoom the view to the crop'}
                aria-pressed={isFramed}
              >
                ▣ Frame
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={clearCrop}
                title="Remove the crop (output becomes the full image)"
                aria-label="Remove crop"
              >
                ✕
              </button>
            </>
          )}
          <button
            type="button"
            className={`btn btn-sm ${isFullscreen ? 'btn-active' : ''}`}
            onClick={toggleFullscreen}
            title={isFullscreen ? 'Exit full screen (Esc)' : 'Full screen'}
            aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'}
          >
            ⛶
          </button>
        </div>
      </div>

      <div className={`liveview-stage ${isFramed ? 'is-framed' : ''}`} ref={stageRef}>
        <div
          ref={viewportRef}
          className="liveview-viewport"
          style={{ transform: viewTransform }}
          onPointerDown={onViewPointerDown}
          onPointerMove={onViewPointerMove}
          onPointerUp={onViewPointerUp}
          onPointerCancel={onViewPointerUp}
        >
          <canvas
            ref={canvasRef}
            className="liveview-canvas"
            style={{ cursor: previewZoom > 1 && !isFramed ? 'grab' : 'crosshair' }}
            onClick={(e) => void handleCanvasClick(e)}
            title="Click image to autofocus here"
          />
          {(cropDisplay || cropEditing) && (
            <div
              className="crop-layer"
              style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
            >
              <CropOverlay
                rect={cropDisplay}
                editing={cropEditing && !isFramed}
                framed={isFramed}
                onChange={setCropDraft}
                onCommit={commitCrop}
              />
            </div>
          )}
        </div>
        {showGrid && connected && streaming && !frameError && gridRect.width > 0 && gridRect.height > 0 && (
          <div className="grid-overlay" style={gridRect} aria-hidden="true">
            <span className="grid-line grid-line-v" style={{ left: '33.333%' }} />
            <span className="grid-line grid-line-v" style={{ left: '66.667%' }} />
            <span className="grid-line grid-line-h" style={{ top: '33.333%' }} />
            <span className="grid-line grid-line-h" style={{ top: '66.667%' }} />
          </div>
        )}
        {showHistogram && connected && streaming && !frameError && (
          <canvas
            ref={histCanvasRef}
            width={160}
            height={56}
            className="histogram-overlay"
          />
        )}
        {(!connected || frameError) && (
          <div className="liveview-placeholder">
            {!connected ? 'Not connected to camera' : frameError}
          </div>
        )}
        {!isFramed && connected && (
          <div className="preview-zoom" title="Preview zoom (drag the image to pan)">
            <input
              type="range"
              className="preview-zoom-slider"
              min={1}
              max={MAX_PREVIEW_ZOOM}
              step={0.1}
              value={previewZoom}
              onChange={(e) => changeZoom(Number(e.target.value))}
              aria-label="Preview zoom"
            />
            <button
              type="button"
              className="preview-zoom-label"
              onClick={() => changeZoom(1)}
              title="Reset preview zoom"
            >
              {previewZoom.toFixed(1)}×
            </button>
          </div>
        )}
        {isFullscreen && (
          <button
            type="button"
            className="btn btn-sm fullscreen-exit"
            onClick={toggleFullscreen}
            title="Exit full screen (Esc)"
            aria-label="Exit full screen"
          >
            ✕
          </button>
        )}
        <button
          type="button"
          className="shutter-fab"
          disabled={!connected || capturing}
          onClick={onCapture}
          title="Take Picture"
          aria-label="Take Picture"
        >
          <span className="shutter-inner" />
        </button>
      </div>

      <div className="toolbar-row" style={{ marginTop: 8, justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="output-url-row">
          <span className="muted-tag">{cropImage ? 'Cropped output' : 'Output'}</span>
          <input
            ref={outputUrlRef}
            className="input-sm output-url"
            readOnly
            value={client.outputMjpegUrl()}
            onFocus={(e) => e.currentTarget.select()}
            aria-label="Output stream URL"
            title="MJPEG stream with the crop applied (OBS media source, ffmpeg, VLC)"
          />
          <button type="button" className="btn btn-sm" onClick={() => void copyOutputUrl()}>
            {outputCopied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <div className="toolbar-row" style={{ gap: 6 }}>
          {afStatus !== 'idle' && (
            <span className="badge">
              {afStatus === 'focusing' ? 'AF...' : afStatus === 'ok' ? 'AF OK' : 'AF Fail'}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

function findHeaderEnd(buf: Uint8Array): number {
  for (let i = 0; i <= buf.length - 4; i++) {
    if (
      buf[i] === 13 &&
      buf[i + 1] === 10 &&
      buf[i + 2] === 13 &&
      buf[i + 3] === 10
    ) {
      return i;
    }
  }
  return -1;
}

function drawHistogram(canvas: HTMLCanvasElement, data: Uint8ClampedArray) {
  const bins = new Uint32Array(64);
  for (let i = 0; i < data.length; i += 16) {
    const luma = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
    bins[luma >> 2] += 1;
  }
  let max = 1;
  for (let i = 0; i < 64; i++) {
    if (bins[i] > max) max = bins[i];
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(13, 17, 23, 0.68)';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(220, 235, 255, 0.85)';
  const barW = width / 64;
  for (let i = 0; i < 64; i++) {
    const barH = (bins[i] / max) * (height - 6);
    ctx.fillRect(i * barW, height - barH, Math.max(1, barW - 0.5), barH);
  }
}

function applyFocusPeaking(data: Uint8ClampedArray, w: number, h: number) {
  const threshold = 64;
  const luma = new Uint8Array(w * h);
  for (let p = 0, i = 0; p < data.length; p += 4, i++) {
    luma[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
  }
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const idx = row + x;
      const gx = Math.abs(luma[idx + 1] - luma[idx - 1]);
      const gy = Math.abs(luma[idx + w] - luma[idx - w]);
      if (gx + gy > threshold) {
        const p = idx * 4;
        data[p] = 255;
        data[p + 1] = 48;
        data[p + 2] = 48;
      }
    }
  }
}

function drawFocusBox(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  boxW: number,
  boxH: number,
  zoomText: string,
  color = '#7ee787',
) {
  ctx.save();
  const left = cx - boxW / 2;
  const top = cy - boxH / 2;

  // Box border with outer glow
  ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
  ctx.shadowBlur = 4;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(left, top, boxW, boxH);

  // Corner bracket accents
  const cornerLen = Math.max(6, Math.min(boxW, boxH) * 0.22);
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  // Top-left
  ctx.moveTo(left, top + cornerLen);
  ctx.lineTo(left, top);
  ctx.lineTo(left + cornerLen, top);
  // Top-right
  ctx.moveTo(left + boxW - cornerLen, top);
  ctx.lineTo(left + boxW, top);
  ctx.lineTo(left + boxW, top + cornerLen);
  // Bottom-left
  ctx.moveTo(left, top + boxH - cornerLen);
  ctx.lineTo(left, top + boxH);
  ctx.lineTo(left + cornerLen, top + boxH);
  // Bottom-right
  ctx.moveTo(left + boxW - cornerLen, top + boxH);
  ctx.lineTo(left + boxW, top + boxH);
  ctx.lineTo(left + boxW, top + boxH - cornerLen);
  ctx.stroke();

  // Center crosshair
  const chLen = 5;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - chLen, cy);
  ctx.lineTo(cx + chLen, cy);
  ctx.moveTo(cx, cy - chLen);
  ctx.lineTo(cx, cy + chLen);
  ctx.stroke();

  // Badge label above box
  ctx.font = 'bold 10px monospace';
  const labelW = Math.max(34, Math.ceil(ctx.measureText(zoomText).width) + 8);
  ctx.fillStyle = 'rgba(13, 17, 23, 0.8)';
  ctx.fillRect(left, Math.max(0, top - 16), labelW, 14);
  ctx.fillStyle = color;
  ctx.fillText(zoomText, left + 4, Math.max(11, top - 5));

  ctx.restore();
}
