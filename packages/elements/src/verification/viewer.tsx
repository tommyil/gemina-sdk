/**
 * Internal document viewer for <GeminaVerification> — image canvas with a
 * zoom/rotate toolbar. Port of the console's ZoomableImageViewer skeleton
 * (gemina-console/src/components/viewers/ZoomableImageViewer.tsx): same
 * state/refs/effects shape, with every piece of transform math delegated to
 * `viewer-math.ts` and all styling on the Task 6 `.gemina-verification__*`
 * classes. Task 8 adds wheel zoom, mouse pan, and the double-click fit/100%
 * toggle; later tasks add pinch, overlays + flash, and the magnifier lens.
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
import { centeredTranslation, clampScale, fitScaleFor, zoomAtPoint } from './viewer-math';
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

export function VerificationViewer(props: VerificationViewerProps): React.JSX.Element {
  const { src, alt, relativeRects } = props;
  // flashRects / onFlashComplete / onImageExpired are declared for interface
  // stability and consumed in Task 10.

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const [natural, setNatural] = useState<Size | null>(null);
  const [container, setContainer] = useState<Size>({ w: 0, h: 0 });
  const [transform, setTransform] = useState<Transform>(IDENTITY);
  const [rotation, setRotation] = useState(0); // degrees, multiples of 90

  const [showRects, setShowRects] = useState(false);
  const [magnifierOn, setMagnifierOn] = useState(false);

  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  // Measure the canvas (console lines ~124-133), with a one-shot fallback for
  // environments without ResizeObserver.
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

  // Natural image size (console ~136-139).
  const handleImgLoad = useCallback(() => {
    const img = imgRef.current;
    if (img) setNatural({ w: img.naturalWidth, h: img.naturalHeight });
  }, []);

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

  // Toolbar handlers (console ~251-278). zoomAtPoint returns the SAME object
  // on clamped no-ops, so the updater form bails out of re-rendering.
  const zoomBy = useCallback(
    (factor: number) => {
      const node = canvasRef.current;
      if (!node || !natural) return;
      const rect = node.getBoundingClientRect();
      const fit = currentFitScale();
      setTransform((prev) =>
        zoomAtPoint(prev, factor, rect.width / 2, rect.height / 2, rotation, fit),
      );
    },
    [natural, rotation, currentFitScale],
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
      const factor = event.deltaY > 0 ? 0.92 : 1.08; // console's wheel constants
      zoomAtClientPoint(factor, event.clientX, event.clientY);
    },
    [zoomAtClientPoint],
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
    [atFitScale, transform.tx, transform.ty],
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

  // Double-click toggle (console ~281-294): near fit -> 100% anchored at the
  // click point; otherwise back to centered fit.
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
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
    [natural, container, rotation, transform.scale, currentFitScale, zoomAtClientPoint],
  );

  const handleFit = useCallback(() => {
    if (!natural) return;
    const fit = currentFitScale();
    setTransform({ scale: fit, ...centeredTranslation(natural, container, fit, rotation) });
  }, [natural, container, rotation, currentFitScale]);

  const handleActualSize = useCallback(() => {
    if (!natural) return;
    const target = clampScale(1, currentFitScale());
    setTransform({ scale: target, ...centeredTranslation(natural, container, target, rotation) });
  }, [natural, container, rotation, currentFitScale]);

  const handleRotate = useCallback(() => {
    setRotation((r) => (r + 90) % 360);
  }, []);

  // Overlay toggle only means something while rects exist (console ~450-456).
  const hasRects = relativeRects !== undefined && relativeRects.length > 0;
  useEffect(() => {
    if (!hasRects) setShowRects(false);
  }, [hasRects]);

  // Cursor is the promise of what a drag will do (console ~371-372): zoom-in
  // while the whole page fits (drag is inert; wheel/double-click zooms), grab
  // once zoomed beyond fit, grabbing mid-pan. CSS maps data-cursor to cursors.
  const cursorMode = atFitScale ? 'zoom-in' : isPanning ? 'grabbing' : 'grab';

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
        onDoubleClick={handleDoubleClick}
        onMouseDown={handleMouseDown}
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
          />
        </div>
      </div>
    </div>
  );
}
