import { describe, expect, it } from 'vitest';
import {
  centeredTranslation,
  clampScale,
  easeOutCubic,
  fitScaleFor,
  flashZoomTarget,
  rotatedBox,
  zoomAtPoint,
  type Size,
  type Transform,
} from '../../src/verification/viewer-math';

/**
 * Forward map derived from the console viewer's CSS, NOT from the
 * implementation under test: the content div renders with
 *   left: tx; top: ty; transform: rotate(deg) scale(s); transform-origin: top left
 * so an image point p maps to screen = (tx, ty) + R(deg) * (s * p).
 */
function toScreen(
  imgPt: [number, number],
  t: Transform,
  rotationDeg: number,
): [number, number] {
  const rad = (rotationDeg * Math.PI) / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);
  const x = imgPt[0] * t.scale;
  const y = imgPt[1] * t.scale;
  return [t.tx + (cosA * x - sinA * y), t.ty + (sinA * x + cosA * y)];
}

describe('fitScaleFor', () => {
  const natural: Size = { w: 1000, h: 2000 };

  it('fits a 1000x2000 image into a 500x500 box at 0.25', () => {
    // min(500/1000, 500/2000) = min(0.5, 0.25) = 0.25
    expect(fitScaleFor(natural, { w: 500, h: 500 }, 0)).toBe(0.25);
  });

  it('rotated 90deg in a square box is STILL 0.25 (plan claimed 0.5 — console formula disagrees)', () => {
    // Console formula swaps the axes when rot === 90:
    //   w = natural.h = 2000, h = natural.w = 1000
    //   min(500/2000, 500/1000) = min(0.25, 0.5) = 0.25
    // A square container is symmetric, so rotation cannot change the fit.
    expect(fitScaleFor(natural, { w: 500, h: 500 }, 90)).toBe(0.25);
    expect(fitScaleFor(natural, { w: 500, h: 500 }, 270)).toBe(0.25);
  });

  it('rotation changes the fit in a non-square container', () => {
    // Unrotated in 1000x400: min(1000/1000, 400/2000) = min(1, 0.2) = 0.2
    expect(fitScaleFor(natural, { w: 1000, h: 400 }, 0)).toBe(0.2);
    // Rotated 90deg the image occupies 2000x1000:
    //   min(1000/2000, 400/1000) = min(0.5, 0.4) = 0.4
    expect(fitScaleFor(natural, { w: 1000, h: 400 }, 90)).toBe(0.4);
    // 180deg behaves like 0deg
    expect(fitScaleFor(natural, { w: 1000, h: 400 }, 180)).toBe(0.2);
  });

  it('normalizes negative rotations like the console ((r % 180 + 180) % 180)', () => {
    expect(fitScaleFor(natural, { w: 1000, h: 400 }, -90)).toBe(0.4);
    expect(fitScaleFor(natural, { w: 1000, h: 400 }, -180)).toBe(0.2);
  });

  it('returns 1 for a degenerate container (console guard: isFinite(s) && s > 0)', () => {
    expect(fitScaleFor(natural, { w: 0, h: 500 }, 0)).toBe(1);
    expect(fitScaleFor(natural, { w: 500, h: 0 }, 0)).toBe(1);
  });
});

describe('rotatedBox', () => {
  const natural: Size = { w: 100, h: 200 };
  const s = 2;

  it('rot 0: unrotated extents, no offset', () => {
    expect(rotatedBox(natural, s, 0)).toEqual({ W: 200, H: 400, minX: 0, minY: 0 });
  });

  it('rot 90: swapped extents, minX compensates -h0*s', () => {
    expect(rotatedBox(natural, s, 90)).toEqual({ W: 400, H: 200, minX: -400, minY: 0 });
  });

  it('rot 180: unswapped extents, both offsets negative', () => {
    expect(rotatedBox(natural, s, 180)).toEqual({ W: 200, H: 400, minX: -200, minY: -400 });
  });

  it('rot 270: swapped extents, minY compensates -w0*s', () => {
    expect(rotatedBox(natural, s, 270)).toEqual({ W: 400, H: 200, minX: 0, minY: -200 });
  });

  it('normalizes 360 -> 0 and -90 -> 270 (console: ((rotation % 360) + 360) % 360)', () => {
    expect(rotatedBox(natural, s, 360)).toEqual(rotatedBox(natural, s, 0));
    expect(rotatedBox(natural, s, -90)).toEqual(rotatedBox(natural, s, 270));
    expect(rotatedBox(natural, s, 450)).toEqual(rotatedBox(natural, s, 90));
  });
});

describe('centeredTranslation', () => {
  const natural: Size = { w: 100, h: 200 };
  const container: Size = { w: 500, h: 500 };

  it('centers the unrotated image', () => {
    // W=100, H=200 at s=1 -> tx=(500-100)/2=200, ty=(500-200)/2=150
    expect(centeredTranslation(natural, container, 1, 0)).toEqual({ tx: 200, ty: 150 });
  });

  it('centers the 90deg-rotated image (offset compensation)', () => {
    // Box at 90deg, s=1: W=200, H=100, minX=-200, minY=0
    // tx = (500-200)/2 - (-200) = 150 + 200 = 350; ty = (500-100)/2 = 200
    expect(centeredTranslation(natural, container, 1, 90)).toEqual({ tx: 350, ty: 200 });
  });

  it('maps the image center to the container center for every rotation', () => {
    // Derived from the forward map, independent of the switch's exact offsets.
    for (const deg of [0, 90, 180, 270]) {
      const { tx, ty } = centeredTranslation(natural, container, 1.5, deg);
      const t: Transform = { scale: 1.5, tx, ty };
      const [sx, sy] = toScreen([natural.w / 2, natural.h / 2], t, deg);
      expect(sx, `rot ${deg}`).toBeCloseTo(container.w / 2, 10);
      expect(sy, `rot ${deg}`).toBeCloseTo(container.h / 2, 10);
    }
  });
});

describe('clampScale', () => {
  it('clamps to [fitScale, 8] by default', () => {
    expect(clampScale(0.1, 0.25)).toBe(0.25);
    expect(clampScale(10, 0.25)).toBe(8);
    expect(clampScale(3, 0.25)).toBe(3);
  });

  it('respects an explicit max', () => {
    expect(clampScale(3, 0.25, 1.8)).toBe(1.8);
    expect(clampScale(1, 0.25, 1.8)).toBe(1);
  });
});

describe('zoomAtPoint', () => {
  const fitScale = 0.25;

  it('multiplies the scale by the factor when unclamped', () => {
    const current: Transform = { scale: 1, tx: 20, ty: 30 };
    const next = zoomAtPoint(current, 1.2, 100, 100, 0, fitScale);
    expect(next.scale).toBeCloseTo(1.2, 10);
  });

  it.each([0, 90, 180, 270])(
    'keeps the image point under the cursor invariant at rotation %ddeg',
    (deg) => {
      // Pick an arbitrary image point, find its screen position via the
      // forward map, zoom anchored there, and require the same image point
      // to land on the same screen position under the new transform.
      const current: Transform = { scale: 0.5, tx: 37, ty: -12 };
      const imgPt: [number, number] = [123, 456];
      const [px, py] = toScreen(imgPt, current, deg);

      const next = zoomAtPoint(current, 1.6, px, py, deg, fitScale);
      expect(next.scale).toBeCloseTo(0.8, 10);

      const [nx, ny] = toScreen(imgPt, next, deg);
      expect(nx).toBeCloseTo(px, 8);
      expect(ny).toBeCloseTo(py, 8);
    },
  );

  it('clamps the new scale to [fitScale, 8]', () => {
    const current: Transform = { scale: 0.5, tx: 0, ty: 0 };
    expect(zoomAtPoint(current, 0.01, 50, 50, 0, fitScale).scale).toBe(fitScale);
    expect(zoomAtPoint(current, 1000, 50, 50, 0, fitScale).scale).toBe(8);
  });

  it('returns the SAME transform object when clamping makes it a no-op (console early return)', () => {
    const current: Transform = { scale: fitScale, tx: 41, ty: 17 };
    const next = zoomAtPoint(current, 0.5, 250, 250, 0, fitScale);
    // Referential identity, not just equality: the viewer relies on the
    // same-object return for React setState bail-out on clamped wheel events.
    expect(next).toBe(current);
  });
});

describe('flashZoomTarget', () => {
  const natural: Size = { w: 1000, h: 2000 };
  const container: Size = { w: 500, h: 500 };
  const fitScale = 0.25;

  it('picks scale so the larger bbox dimension renders at 100px', () => {
    // bbox x: 0.1..0.3 -> 200px wide; y: 0.2..0.25 -> 100px tall
    // larger = 200 -> scaleForTargetSize = 100/200 = 0.5, inside [0.25, 1.8]
    const rects = [{ points: [[0.1, 0.2], [0.3, 0.25]] as [number, number][] }];
    const t = flashZoomTarget(rects, natural, container, 0, fitScale);
    expect(t.scale).toBeCloseTo(0.5, 10);
  });

  it('clamps the scale to at most 1.8 for tiny fields', () => {
    // bbox 0.001 x 0.001 -> 1px x 2px -> scaleForTargetSize = 50 -> clamp 1.8
    const rects = [{ points: [[0.5, 0.5], [0.501, 0.501]] as [number, number][] }];
    expect(flashZoomTarget(rects, natural, container, 0, fitScale).scale).toBe(1.8);
  });

  it('clamps the scale to at least fitScale for huge fields (never zooms out past fit)', () => {
    // bbox 0..1 x 0..1 -> larger = 2000px -> scaleForTargetSize = 0.05 -> clamp fitScale
    const rects = [{ points: [[0, 0], [1, 1]] as [number, number][] }];
    expect(flashZoomTarget(rects, natural, container, 0, fitScale).scale).toBe(fitScale);
  });

  it('uses scaleForTargetSize = 1 for a degenerate zero-size bbox (console guard)', () => {
    const rects = [{ points: [[0.5, 0.5], [0.5, 0.5]] as [number, number][] }];
    // largerDimension = 0 -> 1, clamped into [0.25, 1.8] -> 1
    expect(flashZoomTarget(rects, natural, container, 0, fitScale).scale).toBe(1);
  });

  it('empty rects fall back to scale 1 centered on the image midpoint (defense; callers gate on non-empty)', () => {
    // With no points the bbox stays at its seed (minX=minY=1, maxX=maxY=0):
    //   center = ((1+0)/2) * natural = the image midpoint (500, 1000)
    //   bbox dimensions are negative -> largerDimension not > 0 -> scale 1
    const t = flashZoomTarget([], natural, container, 0, fitScale);
    expect(t.scale).toBe(1); // 1 already inside [0.25, 1.8]
    const [sx, sy] = toScreen([natural.w / 2, natural.h / 2], t, 0);
    expect(sx).toBeCloseTo(container.w / 2, 10);
    expect(sy).toBeCloseTo(container.h / 2, 10);
  });

  it.each([0, 90, 180, 270])(
    'maps the bbox center to the container center at rotation %ddeg',
    (deg) => {
      const rects = [
        { points: [[0.1, 0.2], [0.3, 0.25]] as [number, number][] },
        { points: [[0.15, 0.22], [0.35, 0.3]] as [number, number][] },
      ];
      // Combined bbox: x 0.1..0.35, y 0.2..0.3
      // -> center in image px: (0.225 * 1000, 0.25 * 2000) = (225, 500)
      const t = flashZoomTarget(rects, natural, container, deg, fitScale);
      const [sx, sy] = toScreen([225, 500], t, deg);
      expect(sx, `rot ${deg}`).toBeCloseTo(container.w / 2, 8);
      expect(sy, `rot ${deg}`).toBeCloseTo(container.h / 2, 8);
    },
  );
});

describe('easeOutCubic', () => {
  it('anchors 0 -> 0 and 1 -> 1', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
  });

  it('midpoint: 1 - (1 - 0.5)^3 = 0.875', () => {
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 10);
  });
});
