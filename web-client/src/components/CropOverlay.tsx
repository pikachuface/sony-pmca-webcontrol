import { useRef } from 'react';
import { clamp, type NRect } from './viewGeometry';

type Edge = 'top' | 'right' | 'bottom' | 'left';

interface CropOverlayProps {
  /** Crop in display coordinates (normalized to the displayed image), or null for none. */
  rect: NRect | null;
  /** Edit mode: drag on the image draws a rectangle, the body moves it, the pills resize it. */
  editing: boolean;
  /** Frame mode: everything outside the crop is blacked out. */
  framed: boolean;
  onChange: (rect: NRect | null) => void;
  onCommit: (rect: NRect) => void;
}

/** Smallest crop side while editing, as a fraction of the image. */
const MIN_SIDE = 0.04;

type DragState =
  | { kind: 'draw'; pointerId: number; ox: number; oy: number; prev: NRect | null }
  | { kind: 'move'; pointerId: number; ox: number; oy: number; start: NRect }
  | { kind: 'edge'; pointerId: number; edge: Edge; start: NRect };

/**
 * Crop rectangle over the live view image, positioned by its parent to cover exactly the
 * displayed image. Coordinates come from this element's bounding box, so they stay correct
 * while the view is zoomed or panned with a CSS transform.
 */
export function CropOverlay({ rect, editing, framed, onChange, onCommit }: CropOverlayProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const liveRef = useRef<NRect | null>(rect);
  liveRef.current = rect;

  const pointAt = (e: React.PointerEvent): [number, number] => {
    const box = rootRef.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return [0, 0];
    return [clamp((e.clientX - box.left) / box.width, 0, 1), clamp((e.clientY - box.top) / box.height, 0, 1)];
  };

  const emit = (next: NRect) => {
    liveRef.current = next;
    onChange(next);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!editing || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    rootRef.current?.setPointerCapture(e.pointerId);
    const [px, py] = pointAt(e);
    const edge = (e.target as HTMLElement).dataset.edge as Edge | undefined;
    const current = liveRef.current;
    if (edge && current) {
      dragRef.current = { kind: 'edge', pointerId: e.pointerId, edge, start: current };
    } else if (
      current &&
      px >= current.x &&
      px <= current.x + current.w &&
      py >= current.y &&
      py <= current.y + current.h
    ) {
      dragRef.current = { kind: 'move', pointerId: e.pointerId, ox: px, oy: py, start: current };
    } else {
      dragRef.current = { kind: 'draw', pointerId: e.pointerId, ox: px, oy: py, prev: current };
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const [px, py] = pointAt(e);
    if (drag.kind === 'draw') {
      emit({
        x: Math.min(drag.ox, px),
        y: Math.min(drag.oy, py),
        w: Math.abs(px - drag.ox),
        h: Math.abs(py - drag.oy),
      });
    } else if (drag.kind === 'move') {
      const s = drag.start;
      emit({
        ...s,
        x: clamp(s.x + px - drag.ox, 0, 1 - s.w),
        y: clamp(s.y + py - drag.oy, 0, 1 - s.h),
      });
    } else {
      const s = drag.start;
      const right = s.x + s.w;
      const bottom = s.y + s.h;
      switch (drag.edge) {
        case 'left': {
          const x = clamp(px, 0, right - MIN_SIDE);
          emit({ ...s, x, w: right - x });
          break;
        }
        case 'right':
          emit({ ...s, w: clamp(px, s.x + MIN_SIDE, 1) - s.x });
          break;
        case 'top': {
          const y = clamp(py, 0, bottom - MIN_SIDE);
          emit({ ...s, y, h: bottom - y });
          break;
        }
        case 'bottom':
          emit({ ...s, h: clamp(py, s.y + MIN_SIDE, 1) - s.y });
          break;
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    const final = liveRef.current;
    // A click without a drag (or a sliver) does not replace the crop.
    if (drag.kind === 'draw' && (!final || final.w < MIN_SIDE || final.h < MIN_SIDE)) {
      liveRef.current = drag.prev;
      onChange(drag.prev);
      return;
    }
    if (final) onCommit(final);
  };

  const pct = (v: number) => `${v * 100}%`;
  const visible = rect && rect.w > 0 && rect.h > 0;

  return (
    <div
      ref={rootRef}
      className={`crop-overlay ${editing ? 'is-editing' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {visible && (
        <div
          className={`crop-rect ${framed ? 'is-framed' : ''} ${editing ? 'is-editing' : ''}`}
          style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) }}
        >
          {editing &&
            (['top', 'right', 'bottom', 'left'] as const).map((edge) => (
              <span key={edge} className={`crop-pill crop-pill-${edge}`} data-edge={edge} />
            ))}
        </div>
      )}
    </div>
  );
}
