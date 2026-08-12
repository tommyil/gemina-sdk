/**
 * Pure zoom/rotation math for the verification document viewer.
 *
 * Direct ports from the console's viewer
 * (gemina-console/src/components/viewers/ZoomableImageViewer.tsx):
 * fit scale (lines ~142-149), rotated bounding box (~152-172), centered
 * translation (~174-183), scale clamp + zoom-at-point (~198-230), flash-zoom
 * target (~459-509, math portion), easeOutCubic (~523). Bodies must stay
 * behavior-identical so the elements viewer renders pixel-identically to the
 * console's. No DOM, no React.
 */

export interface Size {
  w: number;
  h: number;
}

export interface Transform {
  scale: number;
  tx: number;
  ty: number;
}

/** Scale that fits a (possibly rotated) natural size into a container. */
export function fitScaleFor(natural: Size, container: Size, rotationDeg: number): number {
  const rot = ((rotationDeg % 180) + 180) % 180;
  const w = rot === 90 ? natural.h : natural.w;
  const h = rot === 90 ? natural.w : natural.h;
  const s = Math.min(container.w / w, container.h / h);
  // The console's memo also early-returns 1 when the container has no size;
  // a zero container makes s = 0 here, so this guard yields the same 1.
  return isFinite(s) && s > 0 ? s : 1;
}

/** Rotated bounding box extents; minX/minY compensate rotation offsets. */
export function rotatedBox(
  natural: Size,
  scale: number,
  rotationDeg: number,
): { W: number; H: number; minX: number; minY: number } {
  const w0 = natural.w;
  const h0 = natural.h;
  const s = scale;
  const rot = ((rotationDeg % 360) + 360) % 360;
  switch (rot) {
    case 0:
      return { W: w0 * s, H: h0 * s, minX: 0, minY: 0 };
    case 90:
      return { W: h0 * s, H: w0 * s, minX: -h0 * s, minY: 0 };
    case 180:
      return { W: w0 * s, H: h0 * s, minX: -w0 * s, minY: -h0 * s };
    case 270:
      return { W: h0 * s, H: w0 * s, minX: 0, minY: -w0 * s };
    default:
      return { W: w0 * s, H: h0 * s, minX: 0, minY: 0 };
  }
}

/** Translation that centers the rotated image. */
export function centeredTranslation(
  natural: Size,
  container: Size,
  scale: number,
  rotationDeg: number,
): { tx: number; ty: number } {
  const { W, H, minX, minY } = rotatedBox(natural, scale, rotationDeg);
  const nx = (container.w - W) / 2 - minX;
  const ny = (container.h - H) / 2 - minY;
  return { tx: nx, ty: ny };
}

export function clampScale(s: number, fitScale: number, max = 8): number {
  return Math.max(fitScale, Math.min(max, s));
}

/** New transform after zooming by `factor` anchored at container point (px,py). */
export function zoomAtPoint(
  current: Transform,
  factor: number,
  px: number,
  py: number,
  rotationDeg: number,
  fitScale: number,
): Transform {
  const { scale, tx, ty } = current;
  const newScale = clampScale(scale * factor, fitScale);
  if (newScale === scale) return current;

  const rad = (rotationDeg * Math.PI) / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);

  const dx = px - tx;
  const dy = py - ty;
  const cx = (cosA * dx + sinA * dy) / scale;
  const cy = (-sinA * dx + cosA * dy) / scale;

  const ntx = px - (cosA * (newScale * cx) - sinA * (newScale * cy));
  const nty = py - (sinA * (newScale * cx) + cosA * (newScale * cy));

  return { scale: newScale, tx: ntx, ty: nty };
}

/** Target transform for the flash-zoom travel: center the rects' bbox at a
 * comfortable size (100px target, scale clamped to [fitScale, 1.8]). */
export function flashZoomTarget(
  rects: Array<{ points: [number, number][] }>,
  natural: Size,
  container: Size,
  rotationDeg: number,
  fitScale: number,
): Transform {
  // Calculate bounding box of all flash rects (in relative coords 0-1)
  let minX = 1,
    minY = 1,
    maxX = 0,
    maxY = 0;
  for (const rect of rects) {
    for (const [px, py] of rect.points) {
      minX = Math.min(minX, px);
      minY = Math.min(minY, py);
      maxX = Math.max(maxX, px);
      maxY = Math.max(maxY, py);
    }
  }

  // Calculate center of the bounding box in image pixel coordinates
  const centerX = ((minX + maxX) / 2) * natural.w;
  const centerY = ((minY + maxY) / 2) * natural.h;
  const bboxWidth = (maxX - minX) * natural.w;
  const bboxHeight = (maxY - minY) * natural.h;

  // Calculate target zoom level from a FIXED baseline (not current zoom)
  // Goal: make the field a comfortable, consistent size on screen
  const rad = (rotationDeg * Math.PI) / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);

  // Target: make the bbox render at approximately this size
  const TARGET_RENDERED_SIZE = 100; // pixels - comfortable reading size

  // Calculate scale needed to render bbox at target size
  // Use the larger dimension to determine scale (so it fits nicely)
  const largerDimension = Math.max(bboxWidth, bboxHeight);
  const scaleForTargetSize = largerDimension > 0 ? TARGET_RENDERED_SIZE / largerDimension : 1;

  // Clamp: at least fitScale (don't zoom out), at most 1.8x (reasonable max)
  const targetScale = Math.max(fitScale, Math.min(scaleForTargetSize, 1.8));

  // Calculate target position to center on the field
  const newScreenX = cosA * centerX * targetScale - sinA * centerY * targetScale;
  const newScreenY = sinA * centerX * targetScale + cosA * centerY * targetScale;
  const targetTx = container.w / 2 - newScreenX;
  const targetTy = container.h / 2 - newScreenY;

  return { scale: targetScale, tx: targetTx, ty: targetTy };
}

// Ease out cubic for smooth deceleration
export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
