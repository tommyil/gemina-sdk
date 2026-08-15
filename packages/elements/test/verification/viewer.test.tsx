/**
 * VerificationViewer — Tasks 7–11: image + toolbar + fit/100%/zoom/rotate,
 * wheel zoom, mouse pan, double-click toggle, touch pan + pinch zoom,
 * coordinate overlays, flash-zoom travel, the image-expiry hook, and the
 * magnifier loupe (show/hide policy + rotation-aware math).
 *
 * Flash animation tests run under fake timers with an explicit rAF shim
 * (requestAnimationFrame → setTimeout(cb, 16)) and Date faked, because the
 * travel/fade loops measure elapsed time via Date.now(), not the rAF
 * timestamp.
 *
 * happy-dom has no layout, so container size is driven by the controllable
 * ResizeObserver stub below (`resizeTo`). With a 500x500 canvas and a
 * 1000x2000 image the fit scale is a real 0.25 (not the degenerate 1), which
 * makes Fit and 100% distinguishable. getBoundingClientRect still reports
 * zeros unless a test mocks it — the offset-anchor test does exactly that to
 * prove client->container-relative conversion happens at the call sites.
 */
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { VerificationViewer } from '../../src/verification/viewer';
import type { RelativeRect } from '../../src/verification/viewer';
import { ensureVerificationStylesInjected } from '../../src/verification/styles';
import { fitScaleFor, flashZoomTarget } from '../../src/verification/viewer-math';

/** Controllable ResizeObserver: records instances; `resizeTo` dispatches a
 * fake contentRect so tests give the canvas a real size. */
class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];

  target: Element | null = null;
  private readonly callback: (
    entries: Array<{ contentRect: { width: number; height: number } }>,
  ) => void;

  constructor(callback: (entries: Array<{ contentRect: { width: number; height: number } }>) => void) {
    this.callback = callback;
    ResizeObserverStub.instances.push(this);
  }

  observe(el: Element): void {
    this.target = el;
  }

  unobserve(): void {}
  disconnect(): void {}

  resizeTo(width: number, height: number): void {
    act(() => {
      this.callback([{ contentRect: { width, height } }]);
    });
  }
}

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
});

beforeEach(() => {
  ResizeObserverStub.instances.length = 0;
});

afterEach(cleanup);

const RECTS: RelativeRect[] = [
  {
    points: [
      [0.1, 0.1],
      [0.3, 0.1],
      [0.3, 0.2],
      [0.1, 0.2],
    ],
  },
];

function renderViewer(extra: Partial<Parameters<typeof VerificationViewer>[0]> = {}) {
  return render(
    <VerificationViewer src="https://example.com/doc.png" alt="Invoice page 1" {...extra} />,
  );
}

function lastResizeObserver(): ResizeObserverStub {
  const ro = ResizeObserverStub.instances[ResizeObserverStub.instances.length - 1];
  if (!ro) throw new Error('no ResizeObserver instance — did the viewer mount?');
  return ro;
}

/** Set natural dimensions, then fire load so load-dependent logic runs. */
function loadImage(container: HTMLElement, w = 1000, h = 2000): HTMLImageElement {
  const img = container.querySelector('img')!;
  Object.defineProperty(img, 'naturalWidth', { value: w, configurable: true });
  Object.defineProperty(img, 'naturalHeight', { value: h, configurable: true });
  fireEvent.load(img);
  return img as HTMLImageElement;
}

/** Canonical sized mount: 500x500 canvas, 1000x2000 image.
 * fit = min(500/1000, 500/2000) = 0.25; centered at (125, 0). */
function mountSized(extra: Partial<Parameters<typeof VerificationViewer>[0]> = {}) {
  const utils = renderViewer(extra);
  lastResizeObserver().resizeTo(500, 500);
  const img = loadImage(utils.container);
  const canvas = utils.container.querySelector('.gemina-verification__canvas') as HTMLElement;
  return { ...utils, img, canvas };
}

/** The transform layer is the img's parent; read its inline geometry. */
function layerOf(img: HTMLImageElement): HTMLElement {
  return img.parentElement as HTMLElement;
}

function transformOf(img: HTMLImageElement): string {
  return layerOf(img).style.transform;
}

function scaleOf(img: HTMLImageElement): number {
  const match = /scale\(([\d.eE+-]+)\)/.exec(transformOf(img));
  if (!match) throw new Error(`no scale() in transform: ${transformOf(img)}`);
  return Number(match[1]);
}

function leftOf(img: HTMLImageElement): number {
  return Number.parseFloat(layerOf(img).style.left);
}

function topOf(img: HTMLImageElement): number {
  return Number.parseFloat(layerOf(img).style.top);
}

/** happy-dom's WheelEvent constructor DROPS the MouseEvent init fields —
 * clientX/clientY come through as undefined (plain mouse events keep them).
 * Build the event and pin the coordinates on, or every zoom anchors at NaN. */
function fireWheel(
  el: HTMLElement,
  init: { deltaY: number; clientX: number; clientY: number },
): boolean {
  const ev = createEvent.wheel(el, { deltaY: init.deltaY, bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clientX', { value: init.clientX, configurable: true });
  Object.defineProperty(ev, 'clientY', { value: init.clientY, configurable: true });
  return fireEvent(el, ev);
}

/** Fire a touch event with a synthesized `touches` list. Unlike happy-dom's
 * WheelEvent (see fireWheel), its TouchEvent constructor KEEPS the `touches`
 * init — probed: `new TouchEvent('touchstart', { touches: [...] })` reports
 * the array back verbatim — so no defineProperty surgery is needed. Plain
 * {clientX, clientY} objects stand in for Touch: the handlers only read
 * `.length` and `[i].clientX/Y`. */
function fireTouch(
  el: HTMLElement,
  type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel',
  touches: Array<{ clientX: number; clientY: number }>,
): void {
  fireEvent[type](el, { touches });
}

/** Give an element a concrete viewport rect (happy-dom reports all zeros). */
function mockRect(
  el: HTMLElement,
  r: { left: number; top: number; width: number; height: number },
): void {
  el.getBoundingClientRect = () =>
    ({
      ...r,
      right: r.left + r.width,
      bottom: r.top + r.height,
      x: r.left,
      y: r.top,
      toJSON: () => r,
    }) as DOMRect;
}

describe('VerificationViewer — rendering', () => {
  it('renders the document image with the given src and alt — alt names the CANVAS label', () => {
    const { container } = renderViewer();
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('https://example.com/doc.png');
    expect(img!.getAttribute('alt')).toBe('Invoice page 1');
    // The canvas is the ONE labeled image to AT; the alt prop is its name.
    const canvas = container.querySelector('.gemina-verification__canvas')!;
    expect(canvas.getAttribute('aria-label')).toBe('Invoice page 1');
  });

  it('without alt, the canvas label falls back to "Document image" (img alt to "Document")', () => {
    const { container } = render(<VerificationViewer src="https://example.com/doc.png" />);
    const canvas = container.querySelector('.gemina-verification__canvas')!;
    expect(canvas.getAttribute('aria-label')).toBe('Document image');
    expect(container.querySelector('img')!.getAttribute('alt')).toBe('Document');
  });

  it('structures the viewer as toolbar + canvas under __viewer', () => {
    const { container } = renderViewer();
    const viewer = container.querySelector('.gemina-verification__viewer');
    expect(viewer).not.toBeNull();
    expect(viewer!.querySelector('.gemina-verification__toolbar')).not.toBeNull();
    const canvas = viewer!.querySelector('.gemina-verification__canvas');
    expect(canvas).not.toBeNull();
    expect(canvas!.querySelector('img')).not.toBeNull();
  });

  it('exposes every toolbar control by its accessible name, with matching title', () => {
    renderViewer();
    const names = [
      'Zoom out',
      'Zoom in',
      'Actual size (100%)',
      'Fit to screen',
      'Rotate 90 degrees',
      'Toggle detection overlays',
    ];
    for (const name of names) {
      const btn = screen.getByRole('button', { name });
      expect(btn.getAttribute('title'), name).toBeNull(); // retired — see tip.tsx
      expect(btn.getAttribute('type')).toBe('button');
    }
    const magnifier = screen.getByRole('switch', { name: 'Magnifier' });
    expect(magnifier.getAttribute('title')).toBeNull(); // retired — see tip.tsx
  });

  it('leaves the img free of inline geometry styling (the stylesheet owns it)', () => {
    const { container } = renderViewer();
    const img = container.querySelector('img')!;
    expect(img.getAttribute('style')).toBeNull();
  });
});

describe('VerificationViewer — overlay + magnifier toggles', () => {
  it('disables the overlay toggle when there are no detection rects', () => {
    renderViewer();
    const toggle = screen.getByRole('button', { name: 'Toggle detection overlays' });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables the overlay toggle with rects and reflects pressed + active state', () => {
    renderViewer({ relativeRects: RECTS });
    const toggle = screen.getByRole('button', { name: 'Toggle detection overlays' });
    expect((toggle as HTMLButtonElement).disabled).toBe(false);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.classList.contains('gemina-verification__toolbar-btn--active')).toBe(true);

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.classList.contains('gemina-verification__toolbar-btn--active')).toBe(false);
  });

  it('clears and disables the overlay toggle when rects go away', () => {
    const { rerender } = renderViewer({ relativeRects: RECTS });
    const toggle = screen.getByRole('button', { name: 'Toggle detection overlays' });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');

    rerender(<VerificationViewer src="https://example.com/doc.png" alt="Invoice page 1" />);
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
  });

  it('magnifier is a switch that flips aria-checked and active styling', () => {
    renderViewer();
    const magnifier = screen.getByRole('switch', { name: 'Magnifier' });
    expect(magnifier.getAttribute('aria-checked')).toBe('false');
    expect(magnifier.classList.contains('gemina-verification__toolbar-btn--active')).toBe(false);

    fireEvent.click(magnifier);
    expect(magnifier.getAttribute('aria-checked')).toBe('true');
    expect(magnifier.classList.contains('gemina-verification__toolbar-btn--active')).toBe(true);

    fireEvent.click(magnifier);
    expect(magnifier.getAttribute('aria-checked')).toBe('false');
  });
});

describe('VerificationViewer — zoom / fit / rotate', () => {
  it('starts at a real fit scale, centered (fit differs from 100%)', () => {
    const { img } = mountSized();
    expect(scaleOf(img)).toBeCloseTo(0.25, 6);
    expect(leftOf(img)).toBeCloseTo(125, 6);
    expect(topOf(img)).toBeCloseTo(0, 6);
  });

  it('Zoom in increases the rendered scale', () => {
    const { img } = mountSized();
    const before = scaleOf(img);

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(scaleOf(img)).toBeGreaterThan(before);
    expect(scaleOf(img)).toBeCloseTo(0.3, 6); // 0.25 * 1.2 toolbar step
  });

  it('Zoom out at the fit floor is a clamped no-op', () => {
    const { img } = mountSized();
    const before = layerOf(img).getAttribute('style');

    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(layerOf(img).getAttribute('style')).toBe(before);
  });

  it('Actual size (100%) sets scale to exactly 1 and re-centers', () => {
    const { img } = mountSized();
    expect(scaleOf(img)).toBeCloseTo(0.25, 6); // fit really differs from 100%

    fireEvent.click(screen.getByRole('button', { name: 'Actual size (100%)' }));
    expect(scaleOf(img)).toBe(1);
    // centered: (500 - 1000)/2 = -250, (500 - 2000)/2 = -750
    expect(leftOf(img)).toBeCloseTo(-250, 6);
    expect(topOf(img)).toBeCloseTo(-750, 6);
  });

  it('Fit to screen returns to the fit scale, centered', () => {
    const { img } = mountSized();
    fireEvent.click(screen.getByRole('button', { name: 'Actual size (100%)' }));
    expect(scaleOf(img)).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Fit to screen' }));
    expect(scaleOf(img)).toBeCloseTo(0.25, 6);
    expect(leftOf(img)).toBeCloseTo(125, 6);
    expect(topOf(img)).toBeCloseTo(0, 6);
  });

  it('Rotate 90 degrees advances the rotation in the transform', () => {
    const { container } = renderViewer();
    const img = loadImage(container);
    expect(transformOf(img)).toContain('rotate(0deg)');

    const rotate = screen.getByRole('button', { name: 'Rotate 90 degrees' });
    fireEvent.click(rotate);
    expect(transformOf(img)).toContain('rotate(90deg)');

    fireEvent.click(rotate);
    expect(transformOf(img)).toContain('rotate(180deg)');

    fireEvent.click(rotate);
    fireEvent.click(rotate);
    expect(transformOf(img)).toContain('rotate(0deg)');
  });
});

describe('VerificationViewer — wheel zoom', () => {
  it('wheel up zooms in, wheel down zooms out, floored at fit (console 1.08/0.92)', () => {
    const { img, canvas } = mountSized();
    expect(scaleOf(img)).toBeCloseTo(0.25, 6);

    fireWheel(canvas, { deltaY: -100, clientX: 250, clientY: 250 });
    expect(scaleOf(img)).toBeCloseTo(0.25 * 1.08, 6);
    // Anchored at the canvas center: image point (500, 1000) stays put.
    expect(leftOf(img)).toBeCloseTo(115, 6);
    expect(topOf(img)).toBeCloseTo(-20, 6);

    // 0.27 * 0.92 = 0.2484 clamps to the fit floor, still anchored at the
    // pointer. (Anchor (250, 300), not the center: a center anchor lands ty on
    // a ~1e-14 float whose scientific-notation px value happy-dom's CSS parser
    // drops — browsers accept it fine.)
    const t1 = { s: scaleOf(img), x: leftOf(img), y: topOf(img) };
    fireWheel(canvas, { deltaY: 100, clientX: 250, clientY: 300 });
    expect(scaleOf(img)).toBeCloseTo(0.25, 6);
    expect(leftOf(img)).toBeCloseTo(250 - 0.25 * ((250 - t1.x) / t1.s), 6);
    expect(topOf(img)).toBeCloseTo(300 - 0.25 * ((300 - t1.y) / t1.s), 6);

    // At the floor a further wheel-out is zoomAtPoint's same-object bail-out.
    const before = layerOf(img).getAttribute('style');
    fireWheel(canvas, { deltaY: 100, clientX: 250, clientY: 300 });
    expect(layerOf(img).getAttribute('style')).toBe(before);
  });

  it('cancels the wheel event (non-passive preventDefault contract)', () => {
    const { canvas } = mountSized();
    const notCancelled = fireWheel(canvas, { deltaY: -100, clientX: 250, clientY: 250 });
    expect(notCancelled).toBe(false);
  });

  it('anchors zoom at the pointer when the canvas sits at a non-zero page offset', () => {
    const { img, canvas } = mountSized();
    mockRect(canvas, { left: 100, top: 50, width: 500, height: 500 });

    // Pointer at client (350, 300) = container-relative (250, 250). Expected
    // transform computed with the CSS forward map used in viewer-math.test.ts:
    // screen = (tx, ty) + scale * imagePt at rotation 0, so the image point
    // under the anchor is ((anchor - t0) / s0) and must stay put after zoom.
    const anchor = { x: 350 - 100, y: 300 - 50 };
    const s0 = 0.25;
    const t0 = { x: 125, y: 0 };
    const imagePt = { x: (anchor.x - t0.x) / s0, y: (anchor.y - t0.y) / s0 }; // (500, 1000)
    const s1 = s0 * 1.08;
    const expected = { left: anchor.x - s1 * imagePt.x, top: anchor.y - s1 * imagePt.y }; // (115, -20)

    fireWheel(canvas, { deltaY: -100, clientX: 350, clientY: 300 });

    // A naive console port feeding clientX/Y straight into the elements
    // zoomAtPoint would land at (107, -24) instead.
    expect(scaleOf(img)).toBeCloseTo(s1, 6);
    expect(leftOf(img)).toBeCloseTo(expected.left, 6);
    expect(topOf(img)).toBeCloseTo(expected.top, 6);
    // Invariant: the image point under the pointer did not move.
    expect(leftOf(img) + scaleOf(img) * imagePt.x).toBeCloseTo(anchor.x, 6);
    expect(topOf(img) + scaleOf(img) * imagePt.y).toBeCloseTo(anchor.y, 6);
  });
});

describe('VerificationViewer — mouse pan', () => {
  it('drag pans when zoomed beyond fit; mouseup ends the pan', () => {
    const { img, canvas } = mountSized();
    fireWheel(canvas, { deltaY: -100, clientX: 250, clientY: 250 });
    const startLeft = leftOf(img);
    const startTop = topOf(img);

    fireEvent.mouseDown(canvas, { clientX: 200, clientY: 200 });
    fireEvent.mouseMove(document, { clientX: 240, clientY: 230 });
    expect(leftOf(img)).toBeCloseTo(startLeft + 40, 6);
    expect(topOf(img)).toBeCloseTo(startTop + 30, 6);

    // Deltas are measured from the pan start, not accumulated per event.
    fireEvent.mouseMove(document, { clientX: 210, clientY: 260 });
    expect(leftOf(img)).toBeCloseTo(startLeft + 10, 6);
    expect(topOf(img)).toBeCloseTo(startTop + 60, 6);

    fireEvent.mouseUp(document);
    fireEvent.mouseMove(document, { clientX: 500, clientY: 500 });
    expect(leftOf(img)).toBeCloseTo(startLeft + 10, 6);
    expect(topOf(img)).toBeCloseTo(startTop + 60, 6);
  });

  it('does not engage pan on right/middle button (primary only)', () => {
    const { img, canvas } = mountSized();
    fireWheel(canvas, { deltaY: -100, clientX: 250, clientY: 250 });
    const startLeft = leftOf(img);
    const startTop = topOf(img);

    fireEvent.mouseDown(canvas, { button: 2, clientX: 200, clientY: 200 });
    expect(canvas.getAttribute('data-cursor')).toBe('grab'); // never 'grabbing'
    fireEvent.mouseMove(document, { clientX: 240, clientY: 230 });
    expect(leftOf(img)).toBeCloseTo(startLeft, 6);
    expect(topOf(img)).toBeCloseTo(startTop, 6);
  });

  it('does not engage pan at fit scale (console policy: nothing to pan)', () => {
    const { img, canvas } = mountSized();
    expect(scaleOf(img)).toBeCloseTo(0.25, 6);

    fireEvent.mouseDown(canvas, { clientX: 200, clientY: 200 });
    fireEvent.mouseMove(document, { clientX: 260, clientY: 260 });
    expect(leftOf(img)).toBeCloseTo(125, 6);
    expect(topOf(img)).toBeCloseTo(0, 6);
    expect(canvas.getAttribute('data-cursor')).toBe('zoom-in');
  });
});

describe('VerificationViewer — touch pan + pinch zoom', () => {
  it('two-finger spread zooms in, re-anchored at the moving midpoint per move', () => {
    const { img, canvas } = mountSized();
    expect(scaleOf(img)).toBeCloseTo(0.25, 6);

    fireTouch(canvas, 'touchStart', [
      { clientX: 200, clientY: 250 },
      { clientX: 300, clientY: 250 },
    ]); // dist 100
    fireTouch(canvas, 'touchMove', [
      { clientX: 150, clientY: 250 },
      { clientX: 350, clientY: 250 },
    ]); // dist 200 → factor 2, midpoint (250, 250)
    expect(scaleOf(img)).toBeCloseTo(0.5, 6);
    // Image point under the midpoint: ((250-125)/0.25, (250-0)/0.25) = (500, 1000).
    expect(leftOf(img)).toBeCloseTo(250 - 0.5 * 500, 6); // 0
    expect(topOf(img)).toBeCloseTo(250 - 0.5 * 1000, 6); // -250

    // Second move: the ratio is per-move (state re-seeds to the last dist),
    // so dist 200 → 300 means factor 1.5 on top of the accumulated 0.5.
    fireTouch(canvas, 'touchMove', [
      { clientX: 100, clientY: 250 },
      { clientX: 400, clientY: 250 },
    ]);
    expect(scaleOf(img)).toBeCloseTo(0.75, 6);
    expect(leftOf(img)).toBeCloseTo(250 - 0.75 * 500, 6); // -125
    expect(topOf(img)).toBeCloseTo(250 - 0.75 * 1000, 6); // -500
  });

  it('fingers converging zoom out, floored at fit; at the floor moves bail out', () => {
    const { img, canvas } = mountSized();
    fireWheel(canvas, { deltaY: -100, clientX: 250, clientY: 250 }); // beyond fit: 0.27
    const t1 = { s: scaleOf(img), x: leftOf(img), y: topOf(img) };
    expect(t1.s).toBeGreaterThan(0.25);

    // Converge dist 200 → 40 (factor 0.2): 0.054 clamps to the 0.25 fit floor,
    // anchored at the midpoint (250, 300). (Not (250, 250): that anchor lands
    // ty on float dust whose scientific-notation px happy-dom's CSS parser
    // drops — same pitfall as the wheel test.)
    fireTouch(canvas, 'touchStart', [
      { clientX: 150, clientY: 300 },
      { clientX: 350, clientY: 300 },
    ]);
    fireTouch(canvas, 'touchMove', [
      { clientX: 230, clientY: 300 },
      { clientX: 270, clientY: 300 },
    ]);
    expect(scaleOf(img)).toBeCloseTo(0.25, 6);
    expect(leftOf(img)).toBeCloseTo(250 - 0.25 * ((250 - t1.x) / t1.s), 6);
    expect(topOf(img)).toBeCloseTo(300 - 0.25 * ((300 - t1.y) / t1.s), 6);

    // Further converging at the floor is zoomAtPoint's same-object bail-out.
    const before = layerOf(img).getAttribute('style');
    fireTouch(canvas, 'touchMove', [
      { clientX: 240, clientY: 300 },
      { clientX: 260, clientY: 300 },
    ]);
    expect(layerOf(img).getAttribute('style')).toBe(before);
  });

  it('one-finger drag at fit scale leaves the transform alone (nothing to pan)', () => {
    const { img, canvas } = mountSized();
    fireTouch(canvas, 'touchStart', [{ clientX: 200, clientY: 200 }]);
    fireTouch(canvas, 'touchMove', [{ clientX: 260, clientY: 260 }]);
    expect(scaleOf(img)).toBeCloseTo(0.25, 6);
    expect(leftOf(img)).toBeCloseTo(125, 6);
    expect(topOf(img)).toBeCloseTo(0, 6);
  });

  it('one-finger drag when zoomed pans by start-relative deltas; touch never claims the cursor', () => {
    const { img, canvas } = mountSized();
    fireWheel(canvas, { deltaY: -100, clientX: 250, clientY: 250 });
    const startLeft = leftOf(img);
    const startTop = topOf(img);
    expect(canvas.getAttribute('data-cursor')).toBe('grab');

    fireTouch(canvas, 'touchStart', [{ clientX: 200, clientY: 200 }]);
    expect(canvas.getAttribute('data-cursor')).toBe('grab'); // never 'grabbing' from touch

    fireTouch(canvas, 'touchMove', [{ clientX: 240, clientY: 230 }]);
    expect(leftOf(img)).toBeCloseTo(startLeft + 40, 6);
    expect(topOf(img)).toBeCloseTo(startTop + 30, 6);

    // Deltas are measured from the gesture start, not accumulated per event.
    fireTouch(canvas, 'touchMove', [{ clientX: 210, clientY: 260 }]);
    expect(leftOf(img)).toBeCloseTo(startLeft + 10, 6);
    expect(topOf(img)).toBeCloseTo(startTop + 60, 6);
    expect(canvas.getAttribute('data-cursor')).toBe('grab');

    // Full lift resets the gesture: a stray move does nothing.
    fireTouch(canvas, 'touchEnd', []);
    fireTouch(canvas, 'touchMove', [{ clientX: 400, clientY: 400 }]);
    expect(leftOf(img)).toBeCloseTo(startLeft + 10, 6);
    expect(topOf(img)).toBeCloseTo(startTop + 60, 6);
  });

  it('touchcancel resets the gesture exactly like a full lift (browser-cancelled pinch)', () => {
    const { img, canvas } = mountSized();
    fireTouch(canvas, 'touchStart', [
      { clientX: 200, clientY: 250 },
      { clientX: 300, clientY: 250 },
    ]);
    fireTouch(canvas, 'touchMove', [
      { clientX: 150, clientY: 250 },
      { clientX: 350, clientY: 250 },
    ]);
    expect(scaleOf(img)).toBeCloseTo(0.5, 6); // gesture was live

    // The browser cancels (edge swipe, notification shade): all touches gone.
    fireTouch(canvas, 'touchCancel', []);
    const style = layerOf(img).getAttribute('style');
    fireTouch(canvas, 'touchMove', [
      { clientX: 100, clientY: 250 },
      { clientX: 400, clientY: 250 },
    ]); // stale pinch state would zoom; a reset one is inert
    expect(layerOf(img).getAttribute('style')).toBe(style);

    // Same for a cancelled one-finger pan: a later move must not drag.
    fireTouch(canvas, 'touchStart', [{ clientX: 200, clientY: 200 }]);
    fireTouch(canvas, 'touchCancel', []);
    fireTouch(canvas, 'touchMove', [{ clientX: 400, clientY: 400 }]);
    expect(layerOf(img).getAttribute('style')).toBe(style);
  });

  it('touchEnd with zero touches resets a pinch (a following move does nothing)', () => {
    const { img, canvas } = mountSized();
    fireTouch(canvas, 'touchStart', [
      { clientX: 200, clientY: 250 },
      { clientX: 300, clientY: 250 },
    ]);
    fireTouch(canvas, 'touchMove', [
      { clientX: 150, clientY: 250 },
      { clientX: 350, clientY: 250 },
    ]);
    expect(scaleOf(img)).toBeCloseTo(0.5, 6); // gesture was live

    fireTouch(canvas, 'touchEnd', []);
    fireTouch(canvas, 'touchMove', [
      { clientX: 100, clientY: 250 },
      { clientX: 400, clientY: 250 },
    ]); // no start → inert
    expect(scaleOf(img)).toBeCloseTo(0.5, 6);
    expect(leftOf(img)).toBeCloseTo(0, 6);
    expect(topOf(img)).toBeCloseTo(-250, 6);
  });

  it('2→1 mid-gesture: the remaining finger is inert until a full lift (console-faithful)', () => {
    const { img, canvas } = mountSized();
    fireTouch(canvas, 'touchStart', [
      { clientX: 200, clientY: 250 },
      { clientX: 300, clientY: 250 },
    ]);
    fireTouch(canvas, 'touchMove', [
      { clientX: 150, clientY: 250 },
      { clientX: 350, clientY: 250 },
    ]);
    expect(scaleOf(img)).toBeCloseTo(0.5, 6);
    const style = layerOf(img).getAttribute('style');

    fireTouch(canvas, 'touchEnd', [{ clientX: 150, clientY: 250 }]); // one finger remains
    fireTouch(canvas, 'touchMove', [{ clientX: 190, clientY: 290 }]); // pinch state + 1 touch
    expect(layerOf(img).getAttribute('style')).toBe(style); // no pan, no zoom

    // Full lift, then a fresh one-finger drag pans (we are beyond fit now).
    fireTouch(canvas, 'touchEnd', []);
    fireTouch(canvas, 'touchStart', [{ clientX: 190, clientY: 290 }]);
    fireTouch(canvas, 'touchMove', [{ clientX: 220, clientY: 305 }]);
    expect(leftOf(img)).toBeCloseTo(0 + 30, 6);
    expect(topOf(img)).toBeCloseTo(-250 + 15, 6);
  });

  it('1→2 mid-gesture: the second finger converts the pan into a pinch', () => {
    const { img, canvas } = mountSized();
    fireWheel(canvas, { deltaY: -100, clientX: 250, clientY: 250 });
    const startLeft = leftOf(img);
    const s1 = scaleOf(img);

    fireTouch(canvas, 'touchStart', [{ clientX: 200, clientY: 200 }]);
    fireTouch(canvas, 'touchMove', [{ clientX: 230, clientY: 220 }]);
    expect(leftOf(img)).toBeCloseTo(startLeft + 30, 6); // panning

    // Second finger lands: its touchstart re-fires with BOTH touches → pinch.
    fireTouch(canvas, 'touchStart', [
      { clientX: 230, clientY: 220 },
      { clientX: 330, clientY: 220 },
    ]); // dist 100
    fireTouch(canvas, 'touchMove', [
      { clientX: 205, clientY: 220 },
      { clientX: 355, clientY: 220 },
    ]); // dist 150 → factor 1.5
    expect(scaleOf(img)).toBeCloseTo(s1 * 1.5, 6);
  });

  it('pinch keeps the midpoint image point invariant at a non-zero page offset', () => {
    const { img, canvas } = mountSized();
    mockRect(canvas, { left: 100, top: 50, width: 500, height: 500 });

    // Fingers spread symmetrically about a FIXED client midpoint (350, 300) =
    // container-relative (250, 250), so the forward-map assertion is exact.
    fireTouch(canvas, 'touchStart', [
      { clientX: 300, clientY: 300 },
      { clientX: 400, clientY: 300 },
    ]); // dist 100
    fireTouch(canvas, 'touchMove', [
      { clientX: 250, clientY: 300 },
      { clientX: 450, clientY: 300 },
    ]); // dist 200 → factor 2
    const anchor = { x: 350 - 100, y: 300 - 50 };
    const s0 = 0.25;
    const t0 = { x: 125, y: 0 };
    const imagePt = { x: (anchor.x - t0.x) / s0, y: (anchor.y - t0.y) / s0 }; // (500, 1000)

    // A naive console port feeding clientX/Y straight into the elements
    // zoomAtPoint would anchor at (350, 300) instead and drift.
    expect(scaleOf(img)).toBeCloseTo(0.5, 6);
    expect(leftOf(img) + scaleOf(img) * imagePt.x).toBeCloseTo(anchor.x, 6);
    expect(topOf(img) + scaleOf(img) * imagePt.y).toBeCloseTo(anchor.y, 6);
  });
});

describe('VerificationViewer — double-click', () => {
  it('at fit zooms to 100% anchored at the click point', () => {
    const { img, canvas } = mountSized();

    fireEvent.dblClick(canvas, { clientX: 350, clientY: 150 });
    expect(scaleOf(img)).toBeCloseTo(1, 6);
    // Forward map: image point under the click = ((350-125)/0.25, (150-0)/0.25)
    // = (900, 600); at scale 1 the layer must sit at (350-900, 150-600).
    expect(leftOf(img)).toBeCloseTo(-550, 6);
    expect(topOf(img)).toBeCloseTo(-450, 6);
  });

  it('when zoomed returns to centered fit regardless of the click point', () => {
    const { img, canvas } = mountSized();
    fireEvent.dblClick(canvas, { clientX: 350, clientY: 150 });
    expect(scaleOf(img)).toBeCloseTo(1, 6);

    fireEvent.dblClick(canvas, { clientX: 400, clientY: 100 });
    expect(scaleOf(img)).toBeCloseTo(0.25, 6);
    expect(leftOf(img)).toBeCloseTo(125, 6);
    expect(topOf(img)).toBeCloseTo(0, 6);
  });
});

describe('VerificationViewer — coordinate overlays', () => {
  it('renders rect boxes in image space with numbered badges when toggled on', () => {
    const second: RelativeRect = {
      points: [
        [0.5, 0.6],
        [0.7, 0.6],
        [0.7, 0.65],
        [0.5, 0.65],
      ],
    };
    const { container, img } = mountSized({ relativeRects: [...RECTS, second] });
    expect(container.querySelectorAll('.gemina-verification__rect').length).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'Toggle detection overlays' }));
    const rects = container.querySelectorAll<HTMLElement>('.gemina-verification__rect');
    expect(rects.length).toBe(2);

    // Geometry is proportional to the natural size (1000x2000), inside the
    // transform layer so it scales/pans/rotates with the document.
    const first = rects[0]!;
    expect(first.parentElement).toBe(layerOf(img));
    expect(Number.parseFloat(first.style.left)).toBeCloseTo(100, 6); // 0.1 * 1000
    expect(Number.parseFloat(first.style.top)).toBeCloseTo(200, 6); // 0.1 * 2000
    expect(Number.parseFloat(first.style.width)).toBeCloseTo(200, 6); // 0.2 * 1000
    expect(Number.parseFloat(first.style.height)).toBeCloseTo(200, 6); // 0.1 * 2000

    // Numbered badges, console-style "#1", "#2".
    const badges = container.querySelectorAll('.gemina-verification__rect-badge');
    expect(badges.length).toBe(2);
    expect(badges[0]!.textContent).toBe('#1');
    expect(badges[1]!.textContent).toBe('#2');

    // Decorative to AT: each rect (badge riding inside) is aria-hidden — the
    // canvas is announced as ONE labeled image.
    for (const box of Array.from(rects)) {
      expect(box.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('clamps hairline rects to the console 0.008 minimum size ratio', () => {
    const hairline: RelativeRect[] = [
      {
        points: [
          [0.5, 0.1],
          [0.5, 0.2],
        ],
      },
    ];
    const { container } = mountSized({ relativeRects: hairline });
    fireEvent.click(screen.getByRole('button', { name: 'Toggle detection overlays' }));

    const rect = container.querySelector<HTMLElement>('.gemina-verification__rect')!;
    expect(rect).not.toBeNull();
    expect(Number.parseFloat(rect.style.width)).toBeCloseTo(8, 6); // 0.008 * 1000
    expect(Number.parseFloat(rect.style.height)).toBeCloseTo(200, 6); // real extent kept
  });

  it('skips fully degenerate rects (a single point renders no box)', () => {
    const point: RelativeRect[] = [{ points: [[0.4, 0.4]] }];
    const { container } = mountSized({ relativeRects: point });
    fireEvent.click(screen.getByRole('button', { name: 'Toggle detection overlays' }));
    expect(container.querySelectorAll('.gemina-verification__rect').length).toBe(0);
  });

  it('toggle off removes the rects', () => {
    const { container } = mountSized({ relativeRects: RECTS });
    const toggle = screen.getByRole('button', { name: 'Toggle detection overlays' });
    fireEvent.click(toggle);
    expect(container.querySelectorAll('.gemina-verification__rect').length).toBe(1);

    fireEvent.click(toggle);
    expect(container.querySelectorAll('.gemina-verification__rect').length).toBe(0);
  });
});

describe('VerificationViewer — flash-zoom', () => {
  const SRC = 'https://example.com/doc.png';

  /** Explicit toFake: the travel/fade loops measure elapsed via Date.now(),
   * so Date MUST be faked alongside the setTimeout-backed rAF shim — with a
   * real Date, progress stays ~0 and the animations never complete. */
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.stubGlobal(
      'requestAnimationFrame',
      (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16) as unknown as number,
    );
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** Sized mount that can flip flashRects on via rerender (the eye-click flow). */
  function mountForFlash(onFlashComplete: () => void) {
    const utils = render(
      <VerificationViewer src={SRC} alt="doc" flashRects={null} onFlashComplete={onFlashComplete} />,
    );
    lastResizeObserver().resizeTo(500, 500);
    const img = loadImage(utils.container);
    const canvas = utils.container.querySelector('.gemina-verification__canvas') as HTMLElement;
    const flash = (rects: RelativeRect[] | null) =>
      utils.rerender(
        <VerificationViewer src={SRC} alt="doc" flashRects={rects} onFlashComplete={onFlashComplete} />,
      );
    return { ...utils, img, canvas, flash };
  }

  // RECTS bbox: center (200, 300) in image px, 200x200 → target scale
  // 100/200 = 0.5 (within [fit 0.25, 1.8]); tx = 250 - 200*0.5 = 150,
  // ty = 250 - 300*0.5 = 100.
  const TARGET = { scale: 0.5, tx: 150, ty: 100 };

  it('travels to the flash-zoom target while the flash rect fades, then onFlashComplete', () => {
    const onFlashComplete = vi.fn();
    const { container, img, flash } = mountForFlash(onFlashComplete);
    expect(scaleOf(img)).toBeCloseTo(0.25, 6);

    flash(RECTS);

    // Flash rect appears immediately at full opacity, overlay-rect geometry,
    // hidden from AT (a decorative highlight on the labeled canvas image).
    const rect = container.querySelector<HTMLElement>('.gemina-verification__flash-rect')!;
    expect(rect).not.toBeNull();
    expect(rect.getAttribute('aria-hidden')).toBe('true');
    expect(Number(rect.style.opacity)).toBe(1);
    expect(Number.parseFloat(rect.style.left)).toBeCloseTo(100, 6);
    expect(Number.parseFloat(rect.style.top)).toBeCloseTo(200, 6);

    // Mid-travel (160ms of the 350ms window): strictly between start and target.
    act(() => {
      vi.advanceTimersByTime(160);
    });
    const midScale = scaleOf(img);
    expect(midScale).toBeGreaterThan(0.25);
    expect(midScale).toBeLessThan(TARGET.scale);

    // Travel completes at 350ms → exact target; fade still running.
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(scaleOf(img)).toBeCloseTo(TARGET.scale, 6);
    expect(leftOf(img)).toBeCloseTo(TARGET.tx, 6);
    expect(topOf(img)).toBeCloseTo(TARGET.ty, 6);
    const fading = container.querySelector<HTMLElement>('.gemina-verification__flash-rect')!;
    expect(fading).not.toBeNull();
    const midOpacity = Number(fading.style.opacity);
    expect(midOpacity).toBeGreaterThan(0);
    expect(midOpacity).toBeLessThan(1);
    expect(onFlashComplete).not.toHaveBeenCalled();

    // Past the 1500ms flash window → rect gone, completion fired once.
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(container.querySelector('.gemina-verification__flash-rect')).toBeNull();
    expect(onFlashComplete).toHaveBeenCalledTimes(1);
  });

  it('re-triggering mid-flash restarts cleanly: opacity back to 1, one completion', () => {
    const onFlashComplete = vi.fn();
    const { container, flash } = mountForFlash(onFlashComplete);

    flash(RECTS);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    const rect = container.querySelector<HTMLElement>('.gemina-verification__flash-rect')!;
    expect(Number(rect.style.opacity)).toBeLessThan(1);

    // Rapid second eye-click: a NEW array restarts the flash from the top.
    flash([...RECTS]);
    const restarted = container.querySelector<HTMLElement>('.gemina-verification__flash-rect')!;
    expect(Number(restarted.style.opacity)).toBe(1);

    // 1500ms after the FIRST start the first fade would have completed — it
    // was canceled, so nothing fires and the rect is still up.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(container.querySelector('.gemina-verification__flash-rect')).not.toBeNull();
    expect(onFlashComplete).not.toHaveBeenCalled();

    // The SECOND flash completes on its own 1500ms clock, exactly once.
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(container.querySelector('.gemina-verification__flash-rect')).toBeNull();
    expect(onFlashComplete).toHaveBeenCalledTimes(1);
  });

  it('nulling flashRects mid-flash clears the rect without firing onFlashComplete', () => {
    const onFlashComplete = vi.fn();
    const { container, flash } = mountForFlash(onFlashComplete);

    flash(RECTS);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(container.querySelector('.gemina-verification__flash-rect')).not.toBeNull();

    // The parent declares the flash over: rect gone immediately, no frozen
    // half-faded box left behind, and no echo callback (that would loop).
    flash(null);
    expect(container.querySelector('.gemina-verification__flash-rect')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(2000); // both loops are dead, nothing late fires
    });
    expect(container.querySelector('.gemina-verification__flash-rect')).toBeNull();
    expect(onFlashComplete).not.toHaveBeenCalled();
  });

  it('reduced motion: jumps straight to the target, shows the rect ~800ms, no travel', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    }));
    const onFlashComplete = vi.fn();
    const { container, img, flash } = mountForFlash(onFlashComplete);

    flash(RECTS);

    // No travel: the transform is at the target synchronously.
    expect(scaleOf(img)).toBeCloseTo(TARGET.scale, 6);
    expect(leftOf(img)).toBeCloseTo(TARGET.tx, 6);
    expect(topOf(img)).toBeCloseTo(TARGET.ty, 6);
    const rect = container.querySelector<HTMLElement>('.gemina-verification__flash-rect')!;
    expect(Number(rect.style.opacity)).toBe(1);

    // Still shown (full opacity, transform untouched) most of the way through.
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(container.querySelector('.gemina-verification__flash-rect')).not.toBeNull();
    expect(Number((container.querySelector('.gemina-verification__flash-rect') as HTMLElement).style.opacity)).toBe(1);
    expect(scaleOf(img)).toBeCloseTo(TARGET.scale, 6);
    expect(onFlashComplete).not.toHaveBeenCalled();

    // Past 800ms → rect gone, completion fired.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(container.querySelector('.gemina-verification__flash-rect')).toBeNull();
    expect(onFlashComplete).toHaveBeenCalledTimes(1);
  });

  it('a toolbar zoom mid-travel stops the animated transform (Zoom in / Fit / Actual size)', () => {
    const onFlashComplete = vi.fn();
    const { img, container, flash } = mountForFlash(onFlashComplete);

    // Zoom in: cancels the travel, then applies its own step.
    flash(RECTS);
    act(() => {
      vi.advanceTimersByTime(96); // mid-travel
    });
    const midScale = scaleOf(img);
    expect(midScale).toBeGreaterThan(0.25);
    expect(midScale).toBeLessThan(TARGET.scale);

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    const afterZoom = { s: scaleOf(img), x: leftOf(img), y: topOf(img) };
    expect(afterZoom.s).toBeCloseTo(midScale * 1.2, 6);

    // Travel would have kept driving toward TARGET until 350ms — it must not.
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(scaleOf(img)).toBeCloseTo(afterZoom.s, 6);
    expect(leftOf(img)).toBeCloseTo(afterZoom.x, 6);
    expect(topOf(img)).toBeCloseTo(afterZoom.y, 6);

    // Fit to screen: a FRESH flash re-arms the travel; Fit must kill it too.
    flash([...RECTS]);
    act(() => {
      vi.advanceTimersByTime(96);
    });
    // In-flight precondition: the new travel is really driving (moved beyond
    // its start, short of its target) and sits away from fit — so the Fit
    // click below meaningfully cancels rather than confirming a no-op.
    expect(scaleOf(img)).toBeGreaterThan(afterZoom.s);
    expect(scaleOf(img)).toBeLessThan(TARGET.scale);
    fireEvent.click(screen.getByRole('button', { name: 'Fit to screen' }));
    expect(scaleOf(img)).toBeCloseTo(0.25, 6);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(scaleOf(img)).toBeCloseTo(0.25, 6);
    expect(leftOf(img)).toBeCloseTo(125, 6);
    expect(topOf(img)).toBeCloseTo(0, 6);

    // Actual size: same deal on its own fresh flash.
    flash([...RECTS]);
    act(() => {
      vi.advanceTimersByTime(96);
    });
    // In-flight precondition again: mid-travel between fit and the target.
    expect(scaleOf(img)).toBeGreaterThan(0.25);
    expect(scaleOf(img)).toBeLessThan(TARGET.scale);
    fireEvent.click(screen.getByRole('button', { name: 'Actual size (100%)' }));
    expect(scaleOf(img)).toBe(1);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(scaleOf(img)).toBe(1);
    expect(leftOf(img)).toBeCloseTo(-250, 6);
    expect(topOf(img)).toBeCloseTo(-750, 6);

    // Only the transform drive died each time — the LAST fade still completes
    // and fires exactly once (earlier fades were canceled by the re-triggers).
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(container.querySelector('.gemina-verification__flash-rect')).toBeNull();
    expect(onFlashComplete).toHaveBeenCalledTimes(1);
  });

  it('rotating mid-travel restarts the flash cleanly toward a rotation-correct target', () => {
    const onFlashComplete = vi.fn();
    const { container, img, flash } = mountForFlash(onFlashComplete);

    flash(RECTS);
    act(() => {
      vi.advanceTimersByTime(96); // mid-travel toward the rotation-0 target
    });
    const midScale = scaleOf(img);
    expect(midScale).toBeGreaterThan(0.25);
    expect(midScale).toBeLessThan(TARGET.scale);

    // Rotation is a dep of the flash effect: cleanup cancels both loops, the
    // re-run recomputes the target for the NEW rotation and restarts travel
    // AND fade (opacity back to 1) — never coasting to a stale pre-rotation
    // transform (see handleRotate's comment in viewer.tsx).
    fireEvent.click(screen.getByRole('button', { name: 'Rotate 90 degrees' }));
    const restarted = container.querySelector<HTMLElement>('.gemina-verification__flash-rect')!;
    expect(Number(restarted.style.opacity)).toBe(1);

    const natural = { w: 1000, h: 2000 };
    const box = { w: 500, h: 500 };
    const target90 = flashZoomTarget(RECTS, natural, box, 90, fitScaleFor(natural, box, 90));
    act(() => {
      vi.advanceTimersByTime(400); // past the restarted 350ms travel window
    });
    expect(transformOf(img)).toContain('rotate(90deg)');
    expect(scaleOf(img)).toBeCloseTo(target90.scale, 6);
    expect(leftOf(img)).toBeCloseTo(target90.tx, 6);
    expect(topOf(img)).toBeCloseTo(target90.ty, 6);

    // The restarted fade completes on its own 1500ms clock — exactly once.
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(container.querySelector('.gemina-verification__flash-rect')).toBeNull();
    expect(onFlashComplete).toHaveBeenCalledTimes(1);
  });

  it('a user gesture mid-travel stops the animated transform; the fade still completes', () => {
    const onFlashComplete = vi.fn();
    const { container, img, canvas, flash } = mountForFlash(onFlashComplete);

    flash(RECTS);
    act(() => {
      vi.advanceTimersByTime(96); // mid-travel
    });
    const midScale = scaleOf(img);
    expect(midScale).toBeGreaterThan(0.25);
    expect(midScale).toBeLessThan(TARGET.scale);

    // Wheel gesture: applies its own zoom AND cancels the travel drive.
    fireWheel(canvas, { deltaY: -100, clientX: 250, clientY: 250 });
    const after = { s: scaleOf(img), x: leftOf(img), y: topOf(img) };
    expect(after.s).toBeCloseTo(midScale * 1.08, 6);

    // Travel would have kept driving until 350ms — it must not any more.
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(scaleOf(img)).toBeCloseTo(after.s, 6);
    expect(leftOf(img)).toBeCloseTo(after.x, 6);
    expect(topOf(img)).toBeCloseTo(after.y, 6);

    // The flash rect finishes its fade and completion still fires once.
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(container.querySelector('.gemina-verification__flash-rect')).toBeNull();
    expect(onFlashComplete).toHaveBeenCalledTimes(1);
  });
});

describe('VerificationViewer — reload identity (re-minted URL flow)', () => {
  it('a reload with identical dimensions preserves the user zoom/pan', () => {
    const { img, canvas, rerender } = mountSized();
    fireWheel(canvas, { deltaY: -100, clientX: 250, clientY: 250 });
    const style = layerOf(img).getAttribute('style');
    expect(scaleOf(img)).toBeGreaterThan(0.25);

    // Expiry re-mint: same image behind a fresh URL. The load reports the
    // SAME natural size — the fit effect must not re-run and reset the view.
    rerender(<VerificationViewer src="https://example.com/doc.png?token=reminted" alt="Invoice page 1" />);
    fireEvent.load(img);
    expect(layerOf(img).getAttribute('style')).toBe(style);
  });

  it('a reload with different dimensions still re-fits', () => {
    const { img, canvas, container } = mountSized();
    fireWheel(canvas, { deltaY: -100, clientX: 250, clientY: 250 });
    expect(scaleOf(img)).toBeGreaterThan(0.25);

    loadImage(container, 1000, 1000); // genuinely new image geometry
    expect(scaleOf(img)).toBeCloseTo(0.5, 6); // fresh fit: min(500/1000, 500/1000)
  });
});

describe('VerificationViewer — image expiry', () => {
  it('an error BEFORE any successful load does not fire onImageExpired', () => {
    const onImageExpired = vi.fn();
    const { container } = renderViewer({ onImageExpired });
    fireEvent.error(container.querySelector('img')!);
    expect(onImageExpired).not.toHaveBeenCalled();
  });

  it('an error AFTER a successful load fires onImageExpired', () => {
    const onImageExpired = vi.fn();
    const { container } = renderViewer({ onImageExpired });
    loadImage(container);
    fireEvent.error(container.querySelector('img')!);
    expect(onImageExpired).toHaveBeenCalledTimes(1);
  });

  it('a NEW src that errors before it ever loads does not fire expiry (no mint loop)', () => {
    const onImageExpired = vi.fn();
    const { container, rerender } = renderViewer({ onImageExpired });
    const img = container.querySelector('img')!;
    loadImage(container);

    // The re-minted URL arrives broken: that is a bad URL, not an expiry —
    // firing again would mint forever.
    rerender(
      <VerificationViewer
        src="https://example.com/doc.png?token=broken"
        alt="Invoice page 1"
        onImageExpired={onImageExpired}
      />,
    );
    fireEvent.error(img);
    expect(onImageExpired).not.toHaveBeenCalled();

    // Once the new src DOES load, a later error re-arms and reports again.
    fireEvent.load(img);
    fireEvent.error(img);
    expect(onImageExpired).toHaveBeenCalledTimes(1);
  });

  it('reports once per successful load (a duplicate error does not re-fire)', () => {
    const onImageExpired = vi.fn();
    const { container } = renderViewer({ onImageExpired });
    const img = container.querySelector('img')!;
    loadImage(container);

    fireEvent.error(img);
    fireEvent.error(img);
    expect(onImageExpired).toHaveBeenCalledTimes(1);
  });
});

describe('VerificationViewer — magnifier loupe', () => {
  function loupeOf(container: HTMLElement): HTMLElement | null {
    return container.querySelector<HTMLElement>('.gemina-verification__magnifier');
  }

  function loupeTranslate(loupe: HTMLElement): { x: number; y: number } {
    const transform = loupe.querySelector('img')!.style.transform;
    const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(transform);
    if (!match) throw new Error(`no translate() in loupe transform: ${transform}`);
    return { x: Number(match[1]), y: Number(match[2]) };
  }

  it('shows on mousemove while the switch is on; hides on mouseleave and switch off', () => {
    const { container, canvas } = mountSized();
    expect(loupeOf(container)).toBeNull();

    fireEvent.click(screen.getByRole('switch', { name: 'Magnifier' }));
    // Switch on, but no pointer seen yet — still hidden.
    expect(loupeOf(container)).toBeNull();

    fireEvent.mouseMove(canvas, { clientX: 200, clientY: 300 });
    const loupe = loupeOf(container)!;
    expect(loupe).not.toBeNull();
    // A second img mirroring the document's src (main img + loupe img).
    const inner = loupe.querySelector('img')!;
    expect(inner).not.toBeNull();
    expect(inner.getAttribute('src')).toBe('https://example.com/doc.png');
    expect(container.querySelectorAll('img').length).toBe(2);

    // Pointer leaves the canvas → loupe clears (also how a touch-tap-parked
    // loupe goes away).
    fireEvent.mouseLeave(canvas);
    expect(loupeOf(container)).toBeNull();

    fireEvent.mouseMove(canvas, { clientX: 220, clientY: 310 });
    expect(loupeOf(container)).not.toBeNull();

    fireEvent.click(screen.getByRole('switch', { name: 'Magnifier' }));
    expect(loupeOf(container)).toBeNull();
  });

  it('positions and scales with the console math (150px radius, 2.5x), container-relative', () => {
    const { container, canvas } = mountSized();
    mockRect(canvas, { left: 100, top: 50, width: 500, height: 500 });
    fireEvent.click(screen.getByRole('switch', { name: 'Magnifier' }));

    // Client (300, 350) = container-relative (200, 300). Console math at fit
    // 0.25, tx=125, ty=0: image point = ((200-125)/0.25, 300/0.25) =
    // (300, 1200); zoomScale = 0.25*2.5 = 0.625; translate =
    // (150 - 300*0.625, 150 - 1200*0.625) = (-37.5, -600).
    fireEvent.mouseMove(canvas, { clientX: 300, clientY: 350 });
    const loupe = loupeOf(container)!;
    expect(Number.parseFloat(loupe.style.width)).toBe(300); // 2 * MAG_RADIUS
    expect(Number.parseFloat(loupe.style.height)).toBe(300);
    expect(Number.parseFloat(loupe.style.left)).toBeCloseTo(200 - 150, 6);
    expect(Number.parseFloat(loupe.style.top)).toBeCloseTo(300 - 150, 6);

    const inner = loupe.querySelector('img')!;
    expect(Number.parseFloat(inner.style.width)).toBe(1000); // natural size
    expect(Number.parseFloat(inner.style.height)).toBe(2000);
    expect(inner.style.transform).toContain('rotate(0deg)');
    expect(inner.style.transform).toContain('scale(0.625)');
    // MAG_BORDER is subtracted because the inner img is absolutely positioned
    // and so lands against the loupe's PADDING box, inset by the 2px ring.
    const t = loupeTranslate(loupe);
    expect(t.x).toBeCloseTo(-39.5, 6); // 150 - 2 - 300*0.625
    expect(t.y).toBeCloseTo(-602, 6);  // 150 - 2 - 1200*0.625

    // Pointer past the image's right edge: raw image x 1420 is OFF THE IMAGE.
    // It used to clamp to 1000 and show the right-hand edge column as though
    // it were under the pointer; there is nothing there to magnify, so the
    // loupe hides instead.
    fireEvent.mouseMove(canvas, { clientX: 580, clientY: 70 });
    expect(loupeOf(container)).toBeNull();
  });

  it('keeps the lens and sampled point under a stationary pointer while an ancestor scrolls', () => {
    const { container, canvas } = mountSized();
    let canvasTop = 50;
    canvas.getBoundingClientRect = () => ({
      left: 100,
      top: canvasTop,
      width: 500,
      height: 500,
      right: 600,
      bottom: canvasTop + 500,
      x: 100,
      y: canvasTop,
      toJSON: () => ({}),
    }) as DOMRect;
    fireEvent.click(screen.getByRole('switch', { name: 'Magnifier' }));
    fireEvent.mouseMove(canvas, { clientX: 300, clientY: 350 });
    expect(Number.parseFloat(loupeOf(container)!.style.top)).toBe(150);

    // The modal scrolls 50px beneath a pointer that has not moved. Browsers do
    // not reliably emit mousemove/mouseleave for this; the captured scroll
    // listener must re-project the same client point into the moved canvas.
    canvasTop = 100;
    fireEvent.scroll(document);
    const loupe = loupeOf(container)!;
    expect(Number.parseFloat(loupe.style.top)).toBe(100);
    expect(loupeTranslate(loupe).y).toBeCloseTo(-477, 6);
  });

  it('mirrors the current rotation (rotation-aware loupe math)', () => {
    const { container, canvas } = mountSized();
    fireEvent.click(screen.getByRole('button', { name: 'Rotate 90 degrees' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Magnifier' }));

    // At 90°, re-fit keeps 0.25 (min(500/2000, 500/1000)) with tx=500,
    // ty=125. Pointer at (250, 250): inverse-map → image point (500, 1000);
    // forward at zoomScale 0.625 → rotated (-625, 312.5); translate =
    // (150+625, 150-312.5) = (775, -162.5) — modulo cos(90°) float dust.
    fireEvent.mouseMove(canvas, { clientX: 250, clientY: 250 });
    const loupe = loupeOf(container)!;
    const inner = loupe.querySelector('img')!;
    expect(inner.style.transform).toContain('rotate(90deg)');
    expect(inner.style.transform).toContain('scale(0.625)');
    const t = loupeTranslate(loupe);
    expect(t.x).toBeCloseTo(773, 6);    // 150 - 2 + 625
    expect(t.y).toBeCloseTo(-164.5, 6); // 150 - 2 - 312.5
  });

  it('hides the loupe when the pointer is over the letterbox, not the image', () => {
    // At fit the 1000x2000 image occupies x in [125, 375] of a 500-wide
    // canvas, so x=40 is letterbox — background, not document.
    const { container, canvas } = mountSized();
    fireEvent.click(screen.getByRole('switch', { name: 'Magnifier' }));

    fireEvent.mouseMove(canvas, { clientX: 40, clientY: 250 });
    expect(loupeOf(container)).toBeNull();

    // ...and comes straight back when the pointer returns to the image.
    fireEvent.mouseMove(canvas, { clientX: 250, clientY: 250 });
    expect(loupeOf(container)).not.toBeNull();
  });

  it('hides at every off-image edge, not just one', () => {
    const { container, canvas } = mountSized();
    fireEvent.click(screen.getByRole('switch', { name: 'Magnifier' }));
    for (const [x, y, where] of [
      [40, 250, 'left letterbox'],
      [460, 250, 'right letterbox'],
      [250, -5, 'above the canvas'],
    ] as Array<[number, number, string]>) {
      fireEvent.mouseMove(canvas, { clientX: x, clientY: y });
      expect(loupeOf(container), where).toBeNull();
    }
  });

  it('the exact image edge still counts as ON the image', () => {
    // Boundary: container x=125 maps to image x=0. A strict `<` would blink
    // the loupe out along the whole left edge of the document.
    const { container, canvas } = mountSized();
    fireEvent.click(screen.getByRole('switch', { name: 'Magnifier' }));
    fireEvent.mouseMove(canvas, { clientX: 125, clientY: 0 });
    expect(loupeOf(container)).not.toBeNull();
  });

  it('the border offset in the maths matches the border width in the CSS', () => {
    // The maths compensates for a ring width declared in a different file.
    // If someone restyles the loupe, this fails rather than silently
    // reintroducing the skew the compensation exists to cancel.
    ensureVerificationStylesInjected();
    const sheet = document.head.querySelector('style[data-gemina-verification]')!.textContent!;
    const block = /\.gemina-verification__magnifier\s*\{[^}]*\}/.exec(sheet)!;
    const border = /border:\s*(\d+)px/.exec(block[0]);
    expect(border, 'loupe border declaration').not.toBeNull();
    expect(Number(border![1])).toBe(2); // === MAG_BORDER in viewer.tsx
  });

  it('never intercepts events: pointer-events none rides on the __magnifier class', () => {
    const { container, canvas } = mountSized();
    fireEvent.click(screen.getByRole('switch', { name: 'Magnifier' }));
    fireEvent.mouseMove(canvas, { clientX: 200, clientY: 300 });

    const loupe = loupeOf(container)!;
    expect(loupe.classList.contains('gemina-verification__magnifier')).toBe(true);
    // Chrome stays in CSS: the inline style carries geometry only.
    expect(loupe.getAttribute('style')).not.toContain('pointer-events');

    // The stylesheet's __magnifier block is the source of the rule.
    ensureVerificationStylesInjected();
    const sheet = document.head.querySelector('style[data-gemina-verification]')!.textContent!;
    const block = /\.gemina-verification__magnifier\s*\{[^}]*\}/.exec(sheet);
    expect(block).not.toBeNull();
    expect(block![0]).toContain('pointer-events: none');
  });
});

describe('VerificationViewer — cursor affordance', () => {
  it('tracks the interaction mode: zoom-in at fit, grab when zoomed, grabbing while panning', () => {
    const { canvas } = mountSized();
    expect(canvas.getAttribute('data-cursor')).toBe('zoom-in');

    fireWheel(canvas, { deltaY: -100, clientX: 250, clientY: 250 });
    expect(canvas.getAttribute('data-cursor')).toBe('grab');

    fireEvent.mouseDown(canvas, { clientX: 200, clientY: 200 });
    expect(canvas.getAttribute('data-cursor')).toBe('grabbing');

    fireEvent.mouseUp(document);
    expect(canvas.getAttribute('data-cursor')).toBe('grab');

    fireEvent.click(screen.getByRole('button', { name: 'Fit to screen' }));
    expect(canvas.getAttribute('data-cursor')).toBe('zoom-in');
  });
});
