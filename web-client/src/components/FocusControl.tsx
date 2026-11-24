import { useCallback, useEffect, useRef, useState } from 'react';
import type { AfModePatch, AfModeState, CameraClient, FocusArea, FocusShiftState, SpotSize } from '../api/cameraClient';

interface FocusControlProps {
  client: CameraClient;
  connected: boolean;
  /** The camera's focus offset; offsets are possible only after a successful autofocus. */
  focusShift?: FocusShiftState;
  /** Continuous AF and face detection. */
  afMode?: AfModeState;
  /** Status of the last AutoFocusDone event. */
  afStatus?: number;
  /** Number of faces the camera currently detects. */
  faceCount: number;
  onError: (msg: string) => void;
}

const AREA_LABELS: Record<FocusArea, string> = { wide: 'Wide', center: 'Center', spot: 'Spot' };
const AREA_HINTS: Record<FocusArea, string> = {
  wide: 'Wide: the camera picks the subject over most of the frame',
  center: 'Center: focuses on the middle of the frame',
  spot: 'Spot: a movable focus window; click the live view to place it',
};
const SIZE_LABELS: Record<SpotSize, string> = { small: 'S', medium: 'M', large: 'L' };

/** AutoFocusDone status while continuous AF runs. */
const AF_C_STATUS: Record<number, string> = { 0: 'idle', 1: 'locked', 2: 'no lock', 3: 'focusing', 4: 'tracking' };

const STEP_STORAGE_KEY = 'pmca_focus_step';
const DEFAULT_STEP = 4;
const DEFAULT_RANGE = 16;
/** Wheel distance (in pixels) that counts as one detent; a mouse notch is about 100px. */
const WHEEL_PX_PER_TICK = 100;
const WHEEL_PX_PER_LINE = 33;
/** Vertical drag distance (in pixels) per detent. */
const DRAG_PX_PER_TICK = 12;
/** Knob travel at either end of the offset range, like a potentiometer. */
const KNOB_SWEEP_DEG = 135;

function loadStep(): number {
  try {
    const v = Number(localStorage.getItem(STEP_STORAGE_KEY));
    if (Number.isInteger(v) && v >= 1 && v <= DEFAULT_RANGE) return v;
  } catch {}
  return DEFAULT_STEP;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Focus fine-tuning around the last AF point: [-] (knob) [+].
 *
 * Bodies without focus drive (ILCE-7) only offer CameraEx.shiftFocusPosition, which sets focus
 * to "AF position + offset" with the offset limited to about ±16. So the knob works like a
 * potentiometer with end stops: it shows where in that range focus is, each detent moves the
 * offset by the step size (1 while Shift is held), and a new AF (click the live view) moves
 * the base and returns the knob to 0.
 */
export function FocusControl({ client, connected, focusShift, afMode, afStatus, faceCount, onError }: FocusControlProps) {
  const [stepInput, setStepInput] = useState<string>(() => String(loadStep()));
  const [shiftHeld, setShiftHeld] = useState(false);
  const [busy, setBusy] = useState(false);
  const [modeBusy, setModeBusy] = useState(false);

  const continuous = afMode?.continuous === true;
  const faces = afMode?.faces === true;
  const area: FocusArea = afMode?.area ?? 'spot';
  const spotSize: SpotSize = afMode?.spotSize ?? 'large';
  const ready = connected && focusShift?.ready === true && !continuous;
  const min = focusShift?.min ?? -DEFAULT_RANGE;
  const max = focusShift?.max ?? DEFAULT_RANGE;
  const cameraOffset = focusShift?.offset ?? 0;

  // The offset the user dialled in; requests chase it, so fast turning sends only the latest.
  const [target, setTarget] = useState(cameraOffset);
  const targetRef = useRef<number>(target);
  const inFlightRef = useRef(false);

  const knobRef = useRef<HTMLDivElement | null>(null);
  const wheelAccumRef = useRef(0);
  const dragRef = useRef<{ pointerId: number; lastY: number; accum: number } | null>(null);

  const parsedStep = Number(stepInput);
  const step = Number.isInteger(parsedStep) && parsedStep >= 1 ? Math.min(parsedStep, max) : DEFAULT_STEP;
  const live = useRef({ step, ready, min, max, cameraOffset });
  live.current = { step, ready, min, max, cameraOffset };

  useEffect(() => {
    try {
      localStorage.setItem(STEP_STORAGE_KEY, String(step));
    } catch {}
  }, [step]);

  const applyTarget = (v: number) => {
    targetRef.current = v;
    setTarget(v);
  };

  // Follow the camera (a new AF resets the offset to 0) unless a change is being sent.
  useEffect(() => {
    if (!inFlightRef.current) applyTarget(cameraOffset);
  }, [cameraOffset, focusShift?.ready]);

  // Shift switches every input to single steps while held.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setShiftHeld(e.type === 'keydown');
    };
    const onBlur = () => setShiftHeld(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // One request in flight; whatever is dialled meanwhile goes out next.
  const flush = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    try {
      let sent: number | null = null;
      while (sent !== targetRef.current) {
        const want: number = targetRef.current;
        const res = await client.setFocusOffset(want);
        sent = want;
        if (!res.accepted) {
          applyTarget(res.offset);
          onError('Camera rejected the focus offset');
          break;
        }
        if (targetRef.current === want) applyTarget(res.offset);
      }
    } catch (err) {
      applyTarget(live.current.cameraOffset);
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }, [client, onError]);

  const setOffset = useCallback(
    (value: number) => {
      const { ready: ok, min: lo, max: hi } = live.current;
      if (!ok) return;
      const next = clamp(value, lo, hi);
      if (next === targetRef.current) return;
      applyTarget(next);
      void flush();
    },
    [flush],
  );

  const turn = useCallback(
    (detents: number, single: boolean) => {
      if (detents === 0) return;
      const perDetent = single ? 1 : live.current.step;
      setOffset(targetRef.current + detents * perDetent);
    },
    [setOffset],
  );

  // Native wheel listener: React's onWheel is passive and cannot stop the page from scrolling.
  useEffect(() => {
    const el = knobRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Browsers turn Shift+wheel into horizontal scrolling, so read whichever axis moved.
      const raw = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      const px = e.deltaMode === 1 ? raw * WHEEL_PX_PER_LINE : e.deltaMode === 2 ? raw * WHEEL_PX_PER_TICK : raw;
      wheelAccumRef.current -= px; // wheel up = clockwise = +
      const detents = Math.trunc(wheelAccumRef.current / WHEEL_PX_PER_TICK);
      if (detents !== 0) {
        wheelAccumRef.current -= detents * WHEEL_PX_PER_TICK;
        turn(detents, e.shiftKey);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [turn]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!ready || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { pointerId: e.pointerId, lastY: e.clientY, accum: 0 };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    drag.accum += drag.lastY - e.clientY; // drag up = +
    drag.lastY = e.clientY;
    const detents = Math.trunc(drag.accum / DRAG_PX_PER_TICK);
    if (detents !== 0) {
      drag.accum -= detents * DRAG_PX_PER_TICK;
      turn(detents, e.shiftKey);
    }
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === e.pointerId) dragRef.current = null;
  };

  const onKnobKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
      e.preventDefault();
      turn(1, e.shiftKey);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
      e.preventDefault();
      turn(-1, e.shiftKey);
    } else if (e.key === 'Home' || e.key === '0') {
      e.preventDefault();
      setOffset(0);
    }
  };

  const changeAfMode = async (patch: AfModePatch) => {
    if (modeBusy) return;
    setModeBusy(true);
    try {
      await client.setAfMode(patch);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setModeBusy(false);
    }
  };

  const effectiveStep = shiftHeld ? 1 : step;
  const offsetLabel = target === 0 ? '±0' : target > 0 ? `+${target}` : String(target);
  const knobDeg = (target / Math.max(1, max)) * KNOB_SWEEP_DEG;
  const markerPct = ((target - min) / Math.max(1, max - min)) * 100;

  return (
    <section className="panel">
      <div className="panel-header">
        <div className="panel-title">
          <span>Focus</span>
          {continuous ? (
            <span className="badge badge-live" title="Continuous AF: status of the camera's last AF report">
              AF-C {afStatus !== undefined ? (AF_C_STATUS[afStatus] ?? afStatus) : ''}
            </span>
          ) : (
            <span className="badge" title="Focus offset from the last autofocus position">
              AF {offsetLabel}
            </span>
          )}
          {faces && <span className="muted-tag">{faceCount === 1 ? '1 face' : `${faceCount} faces`}</span>}
          {(busy || modeBusy) && <span className="muted-tag">{modeBusy ? 'switching…' : 'moving…'}</span>}
        </div>
        <button
          type="button"
          className="btn btn-sm"
          disabled={!ready || target === 0}
          onClick={() => setOffset(0)}
          title="Return focus to where the last autofocus put it"
        >
          Back to AF
        </button>
      </div>

      <div className="quality-row">
        <span className="quality-label">AF</span>
        <div className="segmented" role="group" aria-label="Autofocus mode">
          <button
            type="button"
            className={`segmented-btn ${!continuous ? 'is-active' : ''}`}
            aria-pressed={!continuous}
            disabled={!connected || modeBusy}
            onClick={() => continuous && void changeAfMode({ continuous: false })}
            title="Single AF: click the live view to focus once, then fine-tune with the knob"
          >
            Single
          </button>
          <button
            type="button"
            className={`segmented-btn ${continuous ? 'is-active' : ''}`}
            aria-pressed={continuous}
            disabled={!connected || modeBusy}
            onClick={() => !continuous && void changeAfMode({ continuous: true })}
            title="Continuous AF (AF-C): the camera keeps refocusing on its own"
          >
            Continuous
          </button>
        </div>
        <button
          type="button"
          className={`btn btn-sm ${faces ? 'btn-active' : ''}`}
          aria-pressed={faces}
          disabled={!connected || modeBusy}
          onClick={() => void changeAfMode({ faces: !faces })}
          title="Face detection: the camera finds faces and focuses on them first"
        >
          Faces
        </button>
      </div>

      <div className="quality-row">
        <span className="quality-label">Area</span>
        <div className="segmented" role="group" aria-label="Focus area">
          {(Object.keys(AREA_LABELS) as FocusArea[]).map((a) => (
            <button
              key={a}
              type="button"
              className={`segmented-btn ${area === a ? 'is-active' : ''}`}
              aria-pressed={area === a}
              disabled={!connected || modeBusy}
              onClick={() => area !== a && void changeAfMode({ area: a })}
              title={AREA_HINTS[a]}
            >
              {AREA_LABELS[a]}
            </button>
          ))}
        </div>
        {area === 'spot' && (
          <div className="segmented" role="group" aria-label="Spot size">
            {(Object.keys(SIZE_LABELS) as SpotSize[]).map((z) => (
              <button
                key={z}
                type="button"
                className={`segmented-btn ${spotSize === z ? 'is-active' : ''}`}
                aria-pressed={spotSize === z}
                disabled={!connected || modeBusy}
                onClick={() => spotSize !== z && void changeAfMode({ spotSize: z })}
                title={`Spot size ${SIZE_LABELS[z]}`}
              >
                {SIZE_LABELS[z]}
              </button>
            ))}
          </div>
        )}
      </div>

      {connected && continuous && (
        <p className="focus-lock-hint">
          The camera keeps refocusing{area === 'spot' ? ' in the spot' : area === 'center' ? ' in the centre' : ' over the Wide area'}
          {faces ? ', faces first' : ''}.{' '}
          {area === 'spot' ? 'Click the live view to move the spot.' : 'Click the live view to refocus.'}
        </p>
      )}
      {connected && !continuous && !ready && (
        <p className="focus-lock-hint">
          {area === 'spot'
            ? 'Click the live view to place the spot and autofocus.'
            : `Click the live view to autofocus over the ${area === 'center' ? 'Center' : 'Wide'} area.`}{' '}
          The knob then fine-tunes focus around that point.
        </p>
      )}

      <div className="focus-knob-row">
        <button
          type="button"
          className="btn focus-knob-btn"
          disabled={!ready || target <= min}
          onClick={(e) => turn(-1, e.shiftKey)}
          title={`Focus −${effectiveStep}`}
          aria-label={`Focus minus ${effectiveStep}`}
        >
          −
        </button>
        <div
          ref={knobRef}
          className={`focus-knob ${!ready ? 'is-disabled' : ''}`}
          role="slider"
          aria-label="Focus offset from the AF point: scroll, drag up or down, or use arrow keys"
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={target}
          aria-disabled={!ready}
          tabIndex={ready ? 0 : -1}
          title="Scroll or drag to fine-tune focus around the AF point. Hold Shift for single steps."
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onKnobKeyDown}
        >
          <div className="focus-knob-dial" style={{ transform: `rotate(${knobDeg}deg)` }}>
            <span className="focus-knob-indicator" />
          </div>
        </div>
        <button
          type="button"
          className="btn focus-knob-btn"
          disabled={!ready || target >= max}
          onClick={(e) => turn(1, e.shiftKey)}
          title={`Focus +${effectiveStep}`}
          aria-label={`Focus plus ${effectiveStep}`}
        >
          +
        </button>
      </div>

      <div className={`focus-range ${!ready ? 'is-disabled' : ''}`} aria-hidden="true">
        <div className="focus-range-track">
          <span className="focus-range-center" />
          <span className="focus-range-marker" style={{ left: `${markerPct}%` }} />
        </div>
        <div className="focus-range-labels">
          <span>{min}</span>
          <span>AF</span>
          <span>+{max}</span>
        </div>
      </div>

      <div className="focus-step-row">
        <label htmlFor="focus-step-input">Step size</label>
        <input
          id="focus-step-input"
          type="number"
          min={1}
          max={max}
          className="input-sm"
          value={stepInput}
          onChange={(e) => setStepInput(e.target.value)}
          onBlur={() => setStepInput(String(step))}
          title={`Focus steps per detent (1–${max})`}
        />
        <span className={`muted-tag ${shiftHeld ? 'focus-shift-active' : ''}`}>
          {shiftHeld ? 'Shift: 1 step' : 'Hold Shift for 1 step'}
        </span>
      </div>
    </section>
  );
}
