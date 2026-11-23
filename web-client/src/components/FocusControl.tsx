import { useCallback, useEffect, useRef, useState } from 'react';
import type { CameraClient } from '../api/cameraClient';

interface FocusControlProps {
  client: CameraClient;
  connected: boolean;
  onError: (msg: string) => void;
}

const STEP_STORAGE_KEY = 'pmca_focus_step';
const DEFAULT_STEP = 4;
const MAX_STEP = 64;
/** Wheel distance (in pixels) that counts as one detent; a mouse notch is about 100px. */
const WHEEL_PX_PER_TICK = 100;
const WHEEL_PX_PER_LINE = 33;
/** Vertical drag distance (in pixels) per detent. */
const DRAG_PX_PER_TICK = 12;
/** Knob indicator rotation per detent, purely visual. */
const DEG_PER_TICK = 18;

function loadStep(): number {
  try {
    const v = Number(localStorage.getItem(STEP_STORAGE_KEY));
    if (Number.isInteger(v) && v >= 1 && v <= MAX_STEP) return v;
  } catch {}
  return DEFAULT_STEP;
}

/**
 * Relative focus control: [-] (knob) [+]. Each detent moves focus by the step size, or by 1
 * while Shift is held. Moves go through `highlevel.shiftFocus`, which works on bodies without
 * focus drive (ILCE-7) but reports no absolute position, so the badge shows the net shift
 * since the last reset rather than a lens position.
 */
export function FocusControl({ client, connected, onError }: FocusControlProps) {
  const [stepInput, setStepInput] = useState<string>(() => String(loadStep()));
  const [shiftHeld, setShiftHeld] = useState(false);
  const [netShift, setNetShift] = useState(0);
  const [ticks, setTicks] = useState(0);
  const [busy, setBusy] = useState(false);

  const knobRef = useRef<HTMLDivElement | null>(null);
  const pendingRef = useRef(0);
  const inFlightRef = useRef(false);
  const wheelAccumRef = useRef(0);
  const dragRef = useRef<{ pointerId: number; lastY: number; accum: number } | null>(null);

  const parsedStep = Number(stepInput);
  const step = Number.isInteger(parsedStep) && parsedStep >= 1 ? Math.min(parsedStep, MAX_STEP) : DEFAULT_STEP;
  const stepRef = useRef(step);
  stepRef.current = step;
  const connectedRef = useRef(connected);
  connectedRef.current = connected;

  useEffect(() => {
    try {
      localStorage.setItem(STEP_STORAGE_KEY, String(step));
    } catch {}
  }, [step]);

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

  // Coalesce detents: one request in flight, everything turned meanwhile goes in the next one.
  const flush = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    try {
      while (pendingRef.current !== 0) {
        const steps = pendingRef.current;
        pendingRef.current = 0;
        const res = await client.shiftFocus(steps);
        setNetShift((n) => n + res.applied);
        if (!res.accepted) {
          pendingRef.current = 0;
          onError('Camera rejected the focus shift (end of focus range?)');
        }
      }
    } catch (err) {
      pendingRef.current = 0;
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }, [client, onError]);

  const turn = useCallback(
    (detents: number, single: boolean) => {
      if (!connectedRef.current || detents === 0) return;
      const perDetent = single ? 1 : stepRef.current;
      pendingRef.current += detents * perDetent;
      setTicks((t) => t + detents);
      void flush();
    },
    [flush],
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
    if (!connected || e.button !== 0) return;
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
    }
  };

  const effectiveStep = shiftHeld ? 1 : step;
  const sign = netShift > 0 ? '+' : '';

  return (
    <section className="panel">
      <div className="panel-header">
        <div className="panel-title">
          <span>Focus</span>
          <span className="badge" title="Net focus shift since the last reset (this body reports no absolute position)">
            Δ {sign}
            {netShift}
          </span>
          {busy && <span className="muted-tag">moving…</span>}
        </div>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            setNetShift(0);
            setTicks(0);
          }}
          title="Reset the shift counter (does not move focus)"
        >
          Reset Δ
        </button>
      </div>

      <div className="focus-knob-row">
        <button
          type="button"
          className="btn focus-knob-btn"
          disabled={!connected}
          onClick={(e) => turn(-1, e.shiftKey)}
          title={`Focus −${effectiveStep}`}
          aria-label={`Focus minus ${effectiveStep}`}
        >
          −
        </button>
        <div
          ref={knobRef}
          className={`focus-knob ${!connected ? 'is-disabled' : ''}`}
          role="spinbutton"
          aria-label="Focus knob: scroll, drag up or down, or use arrow keys"
          aria-valuenow={netShift}
          aria-disabled={!connected}
          tabIndex={connected ? 0 : -1}
          title="Scroll or drag to turn focus. Hold Shift for single steps."
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onKnobKeyDown}
        >
          <div className="focus-knob-dial" style={{ transform: `rotate(${ticks * DEG_PER_TICK}deg)` }}>
            <span className="focus-knob-indicator" />
          </div>
        </div>
        <button
          type="button"
          className="btn focus-knob-btn"
          disabled={!connected}
          onClick={(e) => turn(1, e.shiftKey)}
          title={`Focus +${effectiveStep}`}
          aria-label={`Focus plus ${effectiveStep}`}
        >
          +
        </button>
      </div>

      <div className="focus-step-row">
        <label htmlFor="focus-step-input">Step size</label>
        <input
          id="focus-step-input"
          type="number"
          min={1}
          max={MAX_STEP}
          className="input-sm"
          value={stepInput}
          onChange={(e) => setStepInput(e.target.value)}
          onBlur={() => setStepInput(String(step))}
          title={`Focus steps per detent (1–${MAX_STEP})`}
        />
        <span className={`muted-tag ${shiftHeld ? 'focus-shift-active' : ''}`}>
          {shiftHeld ? 'Shift: 1 step' : 'Hold Shift for 1 step'}
        </span>
      </div>
    </section>
  );
}
