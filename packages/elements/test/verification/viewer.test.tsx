/**
 * VerificationViewer — Task 7 skeleton: static image, toolbar, fit/100%/zoom/
 * rotate. Overlay/magnifier toggles exist as state only (visuals arrive in
 * Tasks 10/11).
 *
 * happy-dom has no layout: the canvas measures 0×0, so the fit scale resolves
 * to 1 (viewer-math's degenerate-container fallback). That makes fit === 1
 * here, which the fit/100% assertions below rely on.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { VerificationViewer } from '../../src/verification/viewer';
import type { RelativeRect } from '../../src/verification/viewer';

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
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

/** Set natural dimensions, then fire load so load-dependent logic runs. */
function loadImage(container: HTMLElement, w = 1000, h = 2000): HTMLImageElement {
  const img = container.querySelector('img')!;
  Object.defineProperty(img, 'naturalWidth', { value: w });
  Object.defineProperty(img, 'naturalHeight', { value: h });
  fireEvent.load(img);
  return img as HTMLImageElement;
}

/** The transform layer is the img's parent; read its inline transform. */
function transformOf(img: HTMLImageElement): string {
  return (img.parentElement as HTMLElement).style.transform;
}

function scaleOf(img: HTMLImageElement): number {
  const match = /scale\(([\d.eE+-]+)\)/.exec(transformOf(img));
  if (!match) throw new Error(`no scale() in transform: ${transformOf(img)}`);
  return Number(match[1]);
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
  it('Zoom in increases the rendered scale', () => {
    const { container } = renderViewer();
    const img = loadImage(container);
    const before = scaleOf(img);

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(scaleOf(img)).toBeGreaterThan(before);
  });

  it('Zoom out at the fit floor is a clamped no-op', () => {
    const { container } = renderViewer();
    const img = loadImage(container);
    const before = transformOf(img);

    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(transformOf(img)).toBe(before);
  });

  it('Actual size (100%) sets scale to exactly 1', () => {
    const { container } = renderViewer();
    const img = loadImage(container);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(scaleOf(img)).toBeGreaterThan(1);

    fireEvent.click(screen.getByRole('button', { name: 'Actual size (100%)' }));
    expect(scaleOf(img)).toBe(1);
  });

  it('Fit to screen returns to the fit scale', () => {
    const { container } = renderViewer();
    const img = loadImage(container);
    const fitScale = scaleOf(img); // 1 in the 0×0 happy-dom container

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(scaleOf(img)).toBeGreaterThan(fitScale);

    fireEvent.click(screen.getByRole('button', { name: 'Fit to screen' }));
    expect(scaleOf(img)).toBe(fitScale);
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
