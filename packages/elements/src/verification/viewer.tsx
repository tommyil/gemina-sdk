/**
 * Internal document viewer for <GeminaVerification> — image canvas with a
 * zoom/rotate toolbar. Port of the console's ZoomableImageViewer skeleton
 * (gemina-console/src/components/viewers/ZoomableImageViewer.tsx): same
 * state/refs/effects shape, with the gesture/travel transform math delegated
 * to `viewer-math.ts` (the magnifier's presentation math stays local, exactly
 * as inline as the console's) and all styling on the Task 6
 * `.gemina-verification__*` classes. Tasks 8+9 add wheel zoom, mouse pan, the
 * double-click fit/100% toggle, and touch pan + pinch zoom; Task 10 adds
 * coordinate overlays, the flash-zoom travel animation, and the image-expiry
 * hook; Task 11 adds the magnifier loupe.
 *
 * Coordinate spaces: the console's zoomAtPoint takes clientX/Y and subtracts
 * the canvas rect INSIDE itself; the elements zoomAtPoint (viewer-math.ts) is
 * container-relative, so every DOM call site converts via
 * `zoomAtClientPoint` (Task 7 review carry-forward — a verbatim port anchors
 * wrong in any scrolled/offset layout).
 *
 * SSR-safe: no `window`/`document` access at import time; `ResizeObserver`
 * is only touched inside an effect (with a one-shot measure fallback).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type * as React from 'react';
import {
  centeredTranslation,
  clampScale,
  easeOutCubic,
  fitScaleFor,
  flashZoomTarget,
  zoomAtPoint,
} from './viewer-math';
import type { Size, Transform } from './viewer-math';

/** Axis-aligned detection region in relative image coordinates (0–1). */
export interface RelativeRect {
  points: [number, number][];
}

export interface VerificationViewerProps {
  src: string;
  alt?: string;
  relativeRects?: RelativeRect[];
  flashRects?: RelativeRect[] | null;
  onFlashComplete?: () => void;
  /** Fired when the <img> errors AFTER at least one successful load (URL expiry). */
  onImageExpired?: () => void;
}

// --- Icons ------------------------------------------------------------------
// One hand-drawn family: 16×16 grid, 1.5px stroke, round caps/joins, painted
// with currentColor so the toolbar's normal/active colors flow through. The
// only fills are the two dots of the 1:1 colon. Each icon stays ≤ 6 segments.

function IconBase({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** Shared magnifying-glass body (lens + handle) for the zoom/magnifier trio. */
function GlassBody(): React.JSX.Element {
  return (
    <>
      <circle cx="6.75" cy="6.75" r="4.25" />
      <line x1="9.9" y1="9.9" x2="13.5" y2="13.5" />
    </>
  );
}

export function IconZoomIn(): React.JSX.Element {
  return (
    <IconBase>
      <GlassBody />
      <line x1="4.9" y1="6.75" x2="8.6" y2="6.75" />
      <line x1="6.75" y1="4.9" x2="6.75" y2="8.6" />
    </IconBase>
  );
}

export function IconZoomOut(): React.JSX.Element {
  return (
    <IconBase>
      <GlassBody />
      <line x1="4.9" y1="6.75" x2="8.6" y2="6.75" />
    </IconBase>
  );
}

export function IconMagnifier(): React.JSX.Element {
  return (
    <IconBase>
      <GlassBody />
    </IconBase>
  );
}

/** "1:1" drawn as numeral strokes — actual pixel size. */
export function IconActualSize(): React.JSX.Element {
  return (
    <IconBase>
      <polyline points="2.8 6.2 4 5 4 11" />
      <polyline points="10.8 6.2 12 5 12 11" />
      <circle cx="8" cy="6.75" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="8" cy="9.25" r="0.8" fill="currentColor" stroke="none" />
    </IconBase>
  );
}

/** Two arrows collapsing inward — fit to screen. */
export function IconFit(): React.JSX.Element {
  return (
    <IconBase>
      <line x1="13.8" y1="2.2" x2="9.6" y2="6.4" />
      <polyline points="9.6 3.9 9.6 6.4 12.1 6.4" />
      <line x1="2.2" y1="13.8" x2="6.4" y2="9.6" />
      <polyline points="6.4 12.1 6.4 9.6 3.9 9.6" />
    </IconBase>
  );
}

/** Clockwise circular arrow. */
export function IconRotate(): React.JSX.Element {
  return (
    <IconBase>
      <path d="M11.83 4.79A5 5 0 1 1 8 3" />
      <polyline points="6 1.7 8 3 6 4.3" />
    </IconBase>
  );
}

/** Dashed square — detection overlay regions. */
export function IconOverlay(): React.JSX.Element {
  return (
    <IconBase>
      <rect x="2.75" y="2.75" width="10.5" height="10.5" rx="1.5" strokeDasharray="3 2.2" />
    </IconBase>
  );
}

/** Eye — used by the form's field-peek buttons (Task 12+). */
export function IconEye(): React.JSX.Element {
  return (
    <IconBase>
      <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2.1" />
    </IconBase>
  );
}

// --- Toolbar ----------------------------------------------------------------

interface ToolbarButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** aria-pressed toggle button (overlay toggle). */
  pressed?: boolean;
  /** role="switch" + aria-checked (magnifier). */
  checked?: boolean;
  children: React.ReactNode;
}

function ToolbarButton({
  label,
  onClick,
  disabled,
  pressed,
  checked,
  children,
}: ToolbarButtonProps): React.JSX.Element {
  const active = (pressed ?? checked) === true;
  return (
    <button
      type="button"
      className={
        active
          ? 'gemina-verification__toolbar-btn gemina-verification__toolbar-btn--active'
          : 'gemina-verification__toolbar-btn'
      }
      title={label}
      aria-label={label}
      role={checked === undefined ? undefined : 'switch'}
      aria-checked={checked}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

// --- Viewer -----------------------------------------------------------------

const ZOOM_STEP = 1.2;
const IDENTITY: Transform = { scale: 1, tx: 0, ty: 0 };

// Console flash constants (ZoomableImageViewer ~56-57): the rect fades over
// 1500ms while the transform travels for its first 350ms.
const FLASH_DURATION = 1500; // ms
const ZOOM_ANIMATION_DURATION = 350; // ms - smooth but fast travel animation
/** Reduced motion: no travel, no fade — jump to the target and hold the rect
 * at full opacity for a beat long enough to register, then complete. */
const REDUCED_MOTION_FLASH_MS = 800;

/** Console's minimum visible rect size, as a ratio of the natural dimension
 * (~750): hairline detection boxes stay clickable-eye-visible. */
const MIN_SIZE_RATIO = 0.008;

// Console magnifier constants (ZoomableImageViewer ~59-60).
const MAG_RADIUS = 150; // px — loupe radius (console: 140-160px)
const MAG_ZOOM = 2.5; // magnification applied on top of the current scale

/** Rect geometry in image pixel space — the overlays render INSIDE the
 * transform layer, so left/top/width/height are natural-size pixels and the
 * layer's scale/rotate carries them (console ~742-756). Returns null for
 * degenerate rects (a single point, or no points at all). */
function rectGeometry(
  rect: RelativeRect,
  natural: Size,
): { left: number; top: number; width: number; height: number } | null {
  const xs = rect.points.map((point) => point[0]);
  const ys = rect.points.map((point) => point[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const rawWidthRatio = Math.max(0, Math.max(...xs) - minX);
  const rawHeightRatio = Math.max(0, Math.max(...ys) - minY);
  if (rawWidthRatio <= 0 && rawHeightRatio <= 0) return null;
  return {
    left: minX * natural.w,
    top: minY * natural.h,
    width: Math.max(rawWidthRatio, MIN_SIZE_RATIO) * natural.w,
    height: Math.max(rawHeightRatio, MIN_SIZE_RATIO) * natural.h,
  };
}

export function VerificationViewer(props: VerificationViewerProps): React.JSX.Element {
  const { src, alt, relativeRects, flashRects, onFlashComplete, onImageExpired } = props;

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const [natural, setNatural] = useState<Size | null>(null);
  const [container, setContainer] = useState<Size>({ w: 0, h: 0 });
  const [transform, setTransform] = useState<Transform>(IDENTITY);
  const [rotation, setRotation] = useState(0); // degrees, multiples of 90

  const [showRects, setShowRects] = useState(false);
  const [magnifierOn, setMagnifierOn] = useState(false);

  // Loupe pointer state (console ~37-38): showMag flips on canvas
  // mousemove/mouseleave, mousePos is container-relative. Both track on EVERY
  // move regardless of the switch — console parity — so toggling the switch
  // with the pointer resting over the canvas (keyboard toggle) shows the
  // loupe at the right spot. The per-move re-render is the console's own
  // accepted cost; the loupe subtree is tiny.
  const [showMag, setShowMag] = useState(false);
  const [mousePos, setMousePos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  // Flash animation state (console ~43-57).
  const [flashOpacity, setFlashOpacity] = useState(0);
  const [activeFlashRects, setActiveFlashRects] = useState<RelativeRect[] | null>(null);
  const travelRafRef = useRef<number | null>(null);
  const fadeRafRef = useRef<number | null>(null);
  const reducedFlashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Render-synced mirror of the transform (console's scaleRef/txRef/tyRef):
  // the travel animation reads its from-values here instead of closing over
  // state inside the rAF loop (review carry-forward).
  const transformRef = useRef(transform);
  transformRef.current = transform;

  // Latest-value ref so an inline onFlashComplete prop cannot restart the
  // flash effect on every parent render.
  const onFlashCompleteRef = useRef(onFlashComplete);
  onFlashCompleteRef.current = onFlashComplete;

  // True once the CURRENT src has loaded successfully — the expiry gate.
  const hasLoadedRef = useRef(false);

  // Measure the canvas (console lines ~124-133), with a one-shot fallback for
  // environments without ResizeObserver. contentRect on purpose (unlike the
  // root's stacked observer, which reads border-box): the fit/zoom math needs
  // the CONTENT area the image is positioned within.
  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    if (typeof ResizeObserver === 'undefined') {
      const rect = el.getBoundingClientRect();
      setContainer({ w: rect.width, h: rect.height });
      return;
    }
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (cr) setContainer({ w: cr.width, h: cr.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Natural image size (console ~136-139), with an identity-preserving setter
  // (review carry-forward): a re-minted URL for the SAME image (the
  // onImageExpired flow) reports identical dimensions, and returning the prev
  // object keeps the fit effect from re-running and resetting the user's
  // zoom/pan mid-review.
  const handleImgLoad = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    hasLoadedRef.current = true;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    setNatural((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
  }, []);

  // Expiry hook — replaces the console's fallbackSrc error handler (~374-378).
  // The loaded flag resets on every src change: a NEW src that fails before it
  // ever loads is a broken URL, not an expired one, and firing onImageExpired
  // there would re-mint forever in a loop. It also disarms when it fires, so
  // one load reports at most one expiry (the re-minted load re-arms it).
  useEffect(() => {
    hasLoadedRef.current = false;
  }, [src]);

  const handleImgError = useCallback(() => {
    if (!hasLoadedRef.current) return;
    hasLoadedRef.current = false;
    onImageExpired?.();
  }, [onImageExpired]);

  /** The console's `fitScale` memo, including its degenerate-size guard. */
  const currentFitScale = useCallback((): number => {
    if (!natural || !container.w || !container.h) return 1;
    return fitScaleFor(natural, container, rotation);
  }, [natural, container, rotation]);

  // Fit + center on first load, and re-fit on container/rotation changes
  // (console ~186-196).
  useEffect(() => {
    if (!natural || !container.w || !container.h) return;
    const fit = fitScaleFor(natural, container, rotation);
    const { tx, ty } = centeredTranslation(natural, container, fit, rotation);
    setTransform((prev) =>
      Math.abs(prev.scale - fit) < 0.0001 && prev.tx === tx && prev.ty === ty
        ? prev
        : { scale: fit, tx, ty },
    );
  }, [natural, container, rotation]);

  // DELIBERATE IMPROVEMENT over the console (reviewer-endorsed): the console
  // never cancels the flash travel on user input, so its rAF loop keeps
  // stomping wheel/drag transforms for the rest of its 350ms window. Here any
  // canvas gesture (wheel, mousedown, touchstart, dblclick) AND any toolbar
  // zoom (zoom in/out, fit, 100%) stops the travel — the user just took the
  // wheel. Only the transform drive stops: the flash rect keeps fading, and
  // the fade loop still fires onFlashComplete.
  const cancelFlashTravel = useCallback(() => {
    if (travelRafRef.current !== null) {
      cancelAnimationFrame(travelRafRef.current);
      travelRafRef.current = null;
    }
  }, []);

  // Toolbar handlers (console ~251-278). zoomAtPoint returns the SAME object
  // on clamped no-ops, so the updater form bails out of re-rendering.
  const zoomBy = useCallback(
    (factor: number) => {
      const node = canvasRef.current;
      if (!node || !natural) return;
      cancelFlashTravel();
      const rect = node.getBoundingClientRect();
      const fit = currentFitScale();
      setTransform((prev) =>
        zoomAtPoint(prev, factor, rect.width / 2, rect.height / 2, rotation, fit),
      );
    },
    [natural, rotation, currentFitScale, cancelFlashTravel],
  );

  const handleZoomIn = useCallback(() => zoomBy(ZOOM_STEP), [zoomBy]);
  const handleZoomOut = useCallback(() => zoomBy(1 / ZOOM_STEP), [zoomBy]);

  /** Client -> container-relative conversion lives HERE, at the call sites
   * (wheel, double-click; pinch joins in Task 9) — viewer-math's zoomAtPoint
   * is container-relative by contract. */
  const zoomAtClientPoint = useCallback(
    (factor: number, clientX: number, clientY: number) => {
      const node = canvasRef.current;
      if (!node || !natural) return;
      const rect = node.getBoundingClientRect();
      const fit = currentFitScale();
      setTransform((prev) =>
        zoomAtPoint(prev, factor, clientX - rect.left, clientY - rect.top, rotation, fit),
      );
    },
    [natural, rotation, currentFitScale],
  );

  // Wheel zoom (console ~232-249): React's onWheel is passive, so attach a
  // NON-PASSIVE native listener — preventDefault must keep the page from
  // scrolling under the zoom.
  const handleWheel = useCallback(
    (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      cancelFlashTravel();
      const factor = event.deltaY > 0 ? 0.92 : 1.08; // console's wheel constants
      zoomAtClientPoint(factor, event.clientX, event.clientY);
    },
    [zoomAtClientPoint, cancelFlashTravel],
  );

  useEffect(() => {
    const node = canvasRef.current;
    if (!node) return;
    const listener = (event: WheelEvent) => handleWheel(event);
    node.addEventListener('wheel', listener, { passive: false });
    return () => node.removeEventListener('wheel', listener);
  }, [handleWheel]);

  // Beyond fit there is something to pan; at fit the drag is inert and the
  // cursor honestly says zoom-in (console ~296-322 policy). Shared by the
  // mousedown gate and the cursor state below.
  const atFitScale = transform.scale <= currentFitScale() + 0.001;

  // Mouse pan. Deliberate deviation from the console: move/up listen on
  // `document` while panning so the drag survives leaving the canvas instead
  // of dropping at the edge.
  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Any press grabs the canvas — stop the flash travel before the gates.
      cancelFlashTravel();
      // Primary button only: with document-level listeners a right-click's
      // context menu would swallow the mouseup and leave the pan stuck.
      // (Tap-synthesized compat mouse events report button 0 and pass — fine;
      // Task 9's touch handlers own that path.)
      if (e.button !== 0) return;
      if (atFitScale) return;
      e.preventDefault(); // document-level drag: don't start selections outside the widget
      panStart.current = { x: e.clientX, y: e.clientY, tx: transform.tx, ty: transform.ty };
      setIsPanning(true);
    },
    [atFitScale, transform.tx, transform.ty, cancelFlashTravel],
  );

  useEffect(() => {
    if (!isPanning) return;
    const onMove = (e: MouseEvent) => {
      const start = panStart.current;
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      setTransform((prev) => ({ scale: prev.scale, tx: start.tx + dx, ty: start.ty + dy }));
    };
    const onUp = () => {
      panStart.current = null;
      setIsPanning(false);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    // Cleanup runs on mouseup (isPanning flips false) AND on unmount mid-pan.
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [isPanning]);

  // Touch: one-finger pan (only beyond fit — the mousedown gate's twin) and
  // two-finger pinch zoom. Verbatim console port (~324-369) except the pinch
  // factor routes through zoomAtClientPoint — client → container conversion
  // plus the shared fit-floor clamp — instead of any local math.
  // `touch-action: none` on __canvas (styles.ts) hands these gestures to us,
  // so React's passive onTouch* handlers suffice; no preventDefault needed.
  // Gesture state lives in a ref: nothing re-renders per touch-move except
  // the transform update itself, and isPanning/data-cursor stay mouse-only
  // (a touch screen shows no cursor).
  const touchState = useRef<
    | { mode: 'pan'; x: number; y: number; tx: number; ty: number }
    | { mode: 'pinch'; dist: number }
    | null
  >(null);

  const handleTouchStart = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      // A finger on the canvas grabs it — stop the flash travel.
      cancelFlashTravel();
      // Length checks don't narrow TouchList indexing under
      // noUncheckedIndexedAccess, so a/b/their truthiness carry the guard.
      const a = e.touches[0];
      const b = e.touches[1];
      if (e.touches.length === 2 && a && b) {
        // Only the start distance seeds a pinch — no midpoint is stored,
        // because every move re-anchors at the CURRENT midpoint (console
        // policy). A second finger landing mid-pan arrives here too, so 1→2
        // hands the gesture off to pinch automatically.
        touchState.current = {
          mode: 'pinch',
          dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        };
      } else if (e.touches.length === 1 && a && !atFitScale) {
        touchState.current = { mode: 'pan', x: a.clientX, y: a.clientY, tx: transform.tx, ty: transform.ty };
      } else {
        touchState.current = null;
      }
    },
    [atFitScale, transform.tx, transform.ty, cancelFlashTravel],
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      const state = touchState.current;
      if (!state) return;
      if (state.mode === 'pinch' && e.touches.length === 2) {
        const a = e.touches[0];
        const b = e.touches[1];
        if (!a || !b) return;
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        if (state.dist > 0) {
          // Per-move ratio, re-seeded below: each factor is relative to the
          // LAST move, and the updater-form zoomAtPoint composes it onto the
          // accumulated transform, so React batching can't double-apply a
          // step. Two-finger travel without spread is factor 1 — zoomAtPoint's
          // same-object bail-out makes it a no-op (console policy: a pinch
          // never pans; the image only shifts through the moving anchor while
          // the scale is changing).
          zoomAtClientPoint(dist / state.dist, (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
        }
        state.dist = dist;
      } else if (state.mode === 'pan' && e.touches.length === 1) {
        // START-RELATIVE deltas (the established pan pattern) — never
        // accumulated per event, so a dropped move can't skew the drag.
        const t = e.touches[0];
        if (!t) return;
        setTransform((prev) => ({
          scale: prev.scale,
          tx: state.tx + (t.clientX - state.x),
          ty: state.ty + (t.clientY - state.y),
        }));
      }
    },
    [zoomAtClientPoint],
  );

  // 2→1 deliberately leaves an INERT pinch until every finger lifts
  // (console-faithful): the remaining finger matches neither move branch, so
  // nothing jumps; the next touchstart begins a fresh gesture.
  const handleTouchEnd = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 0) touchState.current = null;
  }, []);

  // Loupe pointer tracking (console ~305-308, ~695-703), container-relative
  // like every other pointer path (Task 7 carry-forward). Show on any canvas
  // mousemove, hide only on mouseleave — console policy verbatim. On a touch
  // device a tap synthesizes compat mousemoves that PARK the loupe at the tap
  // point while the switch is on; the console does nothing about that either
  // (its loupe is a desktop pattern), and the parked loupe clears on the next
  // compat mouseleave. Pan is untouched: it lives on document-level listeners.
  const handleCanvasMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    setShowMag(true);
    setMousePos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  }, []);

  const handleCanvasMouseLeave = useCallback(() => {
    setShowMag(false);
  }, []);

  // Double-click toggle (console ~281-294): near fit -> 100% anchored at the
  // click point; otherwise back to centered fit.
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      cancelFlashTravel();
      if (!natural) return;
      const fit = currentFitScale();
      const nearFit = Math.abs(transform.scale - fit) < 0.001;
      if (nearFit) {
        const target = clampScale(1, fit);
        zoomAtClientPoint(target / transform.scale, e.clientX, e.clientY);
      } else {
        setTransform({ scale: fit, ...centeredTranslation(natural, container, fit, rotation) });
      }
    },
    [natural, container, rotation, transform.scale, currentFitScale, zoomAtClientPoint, cancelFlashTravel],
  );

  const handleFit = useCallback(() => {
    if (!natural) return;
    cancelFlashTravel();
    const fit = currentFitScale();
    setTransform({ scale: fit, ...centeredTranslation(natural, container, fit, rotation) });
  }, [natural, container, rotation, currentFitScale, cancelFlashTravel]);

  const handleActualSize = useCallback(() => {
    if (!natural) return;
    cancelFlashTravel();
    const target = clampScale(1, currentFitScale());
    setTransform({ scale: target, ...centeredTranslation(natural, container, target, rotation) });
  }, [natural, container, rotation, currentFitScale, cancelFlashTravel]);

  // Deliberately does NOT cancelFlashTravel: `rotation` is a dep of the flash
  // effect, so a rotate mid-travel re-runs it — cleanup cancels both loops,
  // then the effect recomputes flashZoomTarget for the NEW rotation and
  // restarts travel (and fade, from full opacity) from the current transform.
  // The rect therefore lands rotation-correct instead of coasting toward a
  // stale pre-rotation target (pinned by the rotate-mid-travel test).
  const handleRotate = useCallback(() => {
    setRotation((r) => (r + 90) % 360);
  }, []);

  // Overlay toggle only means something while rects exist (console ~450-456).
  const hasRects = relativeRects !== undefined && relativeRects.length > 0;
  useEffect(() => {
    if (!hasRects) setShowRects(false);
  }, [hasRects]);

  // Flash animation + zoom-to-rect travel (console ~458-581). Two parallel
  // drives: the transform travels to flashZoomTarget over 350ms (easeOutCubic,
  // from-values read off transformRef), while the flash rect fades 1 - p²
  // over 1500ms. The FADE loop owns completion: it clears the rects and fires
  // onFlashComplete — so a gesture-canceled travel never swallows the
  // callback. Cleanup cancels BOTH loops, which covers unmount mid-flash and
  // makes a re-trigger (rapid eye-clicks re-running this effect) a clean
  // restart; the console leaked its fade loop here and only canceled the
  // travel — fixed deliberately.
  useEffect(() => {
    if (!flashRects || flashRects.length === 0 || !natural || !container.w || !container.h) {
      // A parent nulling flashRects mid-flash declares the flash over: clear
      // the display (cleanup already canceled both loops) WITHOUT firing
      // onFlashComplete — the parent initiated this, echoing back would loop.
      // (The console coasted here on its leaked fade loop to clear the rect;
      // with the leak fixed, the clear must be explicit.) The prev-identity
      // bail keeps the common null→null path render-free.
      setActiveFlashRects((prev) => (prev === null ? prev : null));
      setFlashOpacity(0);
      return;
    }

    const fit = fitScaleFor(natural, container, rotation);
    const target = flashZoomTarget(flashRects, natural, container, rotation, fit);

    setActiveFlashRects(flashRects);
    setFlashOpacity(1);

    const prefersReduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (prefersReduced) {
      // No travel, no fade: jump to the target and hold the rect long enough
      // to register, then complete. (The stylesheet's reduced-motion block is
      // the CSS backstop; this is the JS half.)
      setTransform(target);
      reducedFlashTimeoutRef.current = setTimeout(() => {
        reducedFlashTimeoutRef.current = null;
        setActiveFlashRects(null);
        setFlashOpacity(0);
        onFlashCompleteRef.current?.();
      }, REDUCED_MOTION_FLASH_MS);
      return () => {
        if (reducedFlashTimeoutRef.current !== null) {
          clearTimeout(reducedFlashTimeoutRef.current);
          reducedFlashTimeoutRef.current = null;
        }
      };
    }

    // Travel: capture the from-values ONCE from the render-synced ref (review
    // carry-forward — no state reads inside the rAF loop).
    const from = transformRef.current;
    const zoomStartTime = Date.now();
    const animateZoom = () => {
      const progress = Math.min((Date.now() - zoomStartTime) / ZOOM_ANIMATION_DURATION, 1);
      const eased = easeOutCubic(progress);
      setTransform({
        scale: from.scale + (target.scale - from.scale) * eased,
        tx: from.tx + (target.tx - from.tx) * eased,
        ty: from.ty + (target.ty - from.ty) * eased,
      });
      travelRafRef.current = progress < 1 ? requestAnimationFrame(animateZoom) : null;
    };
    travelRafRef.current = requestAnimationFrame(animateZoom);

    // Flash fade, in parallel: 1 - p² over the 1500ms window, then complete.
    const flashStartTime = Date.now();
    const animateFlash = () => {
      const progress = Math.min((Date.now() - flashStartTime) / FLASH_DURATION, 1);
      setFlashOpacity(1 - progress * progress);
      if (progress < 1) {
        fadeRafRef.current = requestAnimationFrame(animateFlash);
      } else {
        fadeRafRef.current = null;
        setActiveFlashRects(null);
        setFlashOpacity(0);
        onFlashCompleteRef.current?.();
      }
    };
    fadeRafRef.current = requestAnimationFrame(animateFlash);

    return () => {
      cancelFlashTravel();
      if (fadeRafRef.current !== null) {
        cancelAnimationFrame(fadeRafRef.current);
        fadeRafRef.current = null;
      }
    };
    // container is identity-replaced per resize; depend on its values (like
    // the console) so a same-size measurement can't restart a live flash.
  }, [flashRects, natural, container.w, container.h, rotation, cancelFlashTravel]);

  // Cursor is the promise of what a drag will do (console ~371-372): zoom-in
  // while the whole page fits (drag is inert; wheel/double-click zooms), grab
  // once zoomed beyond fit, grabbing mid-pan. CSS maps data-cursor to cursors.
  const cursorMode = atFitScale ? 'zoom-in' : isPanning ? 'grabbing' : 'grab';

  // Magnifier loupe (console ~380-431), rotation-aware: invert the current
  // transform to find the image point under the pointer, clamp it inside the
  // image, then re-project it at scale × MAG_ZOOM so that point lands at the
  // loupe's center. The inverse map mirrors zoomAtPoint's — inline here just
  // as it is in the console (presentation math, not gesture math). NOT
  // ported: the console's opacity-0 placeholder div for switch-on/pointer-away
  // (~432-448) — nothing visible ever animated on it, pure dead weight. The
  // inner img is bare (no onLoad/onError): wiring the expiry handler here
  // would double-fire onImageExpired for one dying URL.
  let magnifier: React.ReactNode = null;
  if (magnifierOn && showMag && natural && transform.scale > 0) {
    const rad = (rotation * Math.PI) / 180;
    const cosA = Math.cos(rad);
    const sinA = Math.sin(rad);
    const dx = mousePos.x - transform.tx;
    const dy = mousePos.y - transform.ty;
    const cxRaw = (cosA * dx + sinA * dy) / transform.scale;
    const cyRaw = (-sinA * dx + cosA * dy) / transform.scale;
    const clampedX = Math.max(0, Math.min(cxRaw, natural.w));
    const clampedY = Math.max(0, Math.min(cyRaw, natural.h));
    const zoomScale = transform.scale * MAG_ZOOM;
    const px = clampedX * zoomScale;
    const py = clampedY * zoomScale;
    const rotatedX = px * cosA - py * sinA;
    const rotatedY = px * sinA + py * cosA;
    const translateX = MAG_RADIUS - rotatedX;
    const translateY = MAG_RADIUS - rotatedY;
    magnifier = (
      <div
        className="gemina-verification__magnifier"
        style={{
          width: MAG_RADIUS * 2,
          height: MAG_RADIUS * 2,
          top: mousePos.y - MAG_RADIUS,
          left: mousePos.x - MAG_RADIUS,
        }}
      >
        <img
          src={src}
          alt=""
          draggable={false}
          style={{
            position: 'absolute',
            width: natural.w,
            height: natural.h,
            transformOrigin: '0 0',
            transform: `translate(${translateX}px, ${translateY}px) rotate(${rotation}deg) scale(${zoomScale})`,
          }}
        />
      </div>
    );
  }

  return (
    <div className="gemina-verification__viewer">
      <div className="gemina-verification__toolbar">
        <ToolbarButton label="Zoom out" onClick={handleZoomOut}>
          <IconZoomOut />
        </ToolbarButton>
        <ToolbarButton label="Zoom in" onClick={handleZoomIn}>
          <IconZoomIn />
        </ToolbarButton>
        <ToolbarButton label="Actual size (100%)" onClick={handleActualSize}>
          <IconActualSize />
        </ToolbarButton>
        <ToolbarButton label="Fit to screen" onClick={handleFit}>
          <IconFit />
        </ToolbarButton>
        <ToolbarButton label="Rotate 90 degrees" onClick={handleRotate}>
          <IconRotate />
        </ToolbarButton>
        <ToolbarButton
          label="Toggle detection overlays"
          pressed={showRects}
          disabled={!hasRects}
          onClick={() => setShowRects((prev) => !prev)}
        >
          <IconOverlay />
        </ToolbarButton>
        <ToolbarButton
          label="Magnifier"
          checked={magnifierOn}
          onClick={() => setMagnifierOn((prev) => !prev)}
        >
          <IconMagnifier />
        </ToolbarButton>
      </div>

      <div
        ref={canvasRef}
        className="gemina-verification__canvas"
        data-cursor={cursorMode}
        // One composite picture to AT: the inner <img>, overlay boxes, flash
        // and loupe are all facets of "the document image" — announcing each
        // separately would be noise, so the canvas is the labeled image and
        // everything inside is presentational. The host's `alt` prop names
        // THIS label (the inner img's alt is unread by AT here but kept for
        // non-AT contexts: broken-image text, save/copy affordances).
        role="img"
        aria-label={alt ?? 'Document image'}
        onDoubleClick={handleDoubleClick}
        onMouseDown={handleMouseDown}
        onMouseMove={handleCanvasMouseMove}
        onMouseLeave={handleCanvasMouseLeave}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        // The browser cancelling a gesture (edge swipe, notification shade)
        // must reset it exactly like a full lift — a stale touchState would
        // make the NEXT touch continue a dead pan/pinch.
        onTouchCancel={handleTouchEnd}
      >
        {/* Canvas geometry (not layout) — inline by design; CSS owns appearance. */}
        <div
          style={{
            position: 'absolute',
            left: transform.tx,
            top: transform.ty,
            transform: `rotate(${rotation}deg) scale(${transform.scale})`,
            transformOrigin: 'top left',
            willChange: 'transform,left,top',
          }}
        >
          <img
            ref={imgRef}
            src={src}
            alt={alt ?? 'Document'}
            draggable={false}
            onLoad={handleImgLoad}
            onError={handleImgError}
          />
          {/* Detection overlays (toggle-controlled, console ~742-792). Index
              keys are stable here: rect arrays are replaced wholesale and the
              boxes are stateless leaves. Geometry inline; appearance in CSS.
              aria-hidden per rect (badge included): the canvas is one labeled
              image to AT — the "#N" chips are visual decoration on it. */}
          {showRects &&
            natural &&
            relativeRects?.map((rect, idx) => {
              const geometry = rectGeometry(rect, natural);
              if (!geometry) return null;
              return (
                <div
                  key={`rect-${idx}`}
                  className="gemina-verification__rect"
                  style={geometry}
                  aria-hidden="true"
                >
                  <span className="gemina-verification__rect-badge">#{idx + 1}</span>
                </div>
              );
            })}
          {/* Flash overlay (temporary, independent of the toggle). Element-level
              opacity is equivalent to the console's per-channel alpha fade
              modulo overlapping-layer compositing — see the __flash-rect
              comment in styles.ts. aria-hidden: purely decorative highlight. */}
          {activeFlashRects &&
            natural &&
            activeFlashRects.map((rect, idx) => {
              const geometry = rectGeometry(rect, natural);
              if (!geometry) return null;
              return (
                <div
                  key={`flash-rect-${idx}`}
                  className="gemina-verification__flash-rect"
                  style={{ ...geometry, opacity: flashOpacity }}
                  aria-hidden="true"
                />
              );
            })}
        </div>
        {magnifier}
      </div>
    </div>
  );
}
