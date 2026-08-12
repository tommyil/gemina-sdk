/**
 * VerificationViewer — Tasks 7+8: image + toolbar + fit/100%/zoom/rotate, and
 * wheel zoom, mouse pan, double-click toggle. Overlay/magnifier toggles exist
 * as state only (visuals arrive in Tasks 10/11).
 *
 * happy-dom has no layout, so container size is driven by the controllable
 * ResizeObserver stub below (`resizeTo`). With a 500x500 canvas and a
 * 1000x2000 image the fit scale is a real 0.25 (not the degenerate 1), which
 * makes Fit and 100% distinguishable. getBoundingClientRect still reports
 * zeros unless a test mocks it — the offset-anchor test does exactly that to
 * prove client->container-relative conversion happens at the call sites.
 */
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { VerificationViewer } from '../../src/verification/viewer';
import type { RelativeRect } from '../../src/verification/viewer';

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
  it('renders the document image with the given src and alt', () => {
    const { container } = renderViewer();
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('https://example.com/doc.png');
    expect(img!.getAttribute('alt')).toBe('Invoice page 1');
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
      expect(btn.getAttribute('title'), name).toBe(name);
      expect(btn.getAttribute('type')).toBe('button');
    }
    const magnifier = screen.getByRole('switch', { name: 'Magnifier' });
    expect(magnifier.getAttribute('title')).toBe('Magnifier');
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
