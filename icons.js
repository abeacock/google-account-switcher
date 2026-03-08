/**
 * icons.js — shared icon-drawing utilities
 *
 * Imported by both background.js (service worker, uses OffscreenCanvas) and
 * popup.js (document context, uses DOM canvas). Each caller supplies a
 * createCanvas(size) factory so the drawing logic stays in one place.
 */

export const ICON_BG_COLORS   = ['#4285F4', '#9c27b0', '#34A853', '#FBBC05', '#EA4335'];
export const ICON_TEXT_COLORS = ['#ffffff', '#ffffff', '#ffffff', '#1a1a1a', '#ffffff'];
export const ICON_SIZES = [16, 32, 48, 128];

/**
 * Draws the four-colour Google grid icon (blue/red/yellow/green quadrants)
 * clipped to a circle. createCanvas(size) must return a canvas-like object
 * with a getContext('2d') method (OffscreenCanvas or HTMLCanvasElement).
 */
export function drawFourSquareImageData(size, createCanvas) {
  const canvas = createCanvas(size);
  const ctx = canvas.getContext('2d');
  const half = size / 2;

  // Clip all drawing to a circle
  ctx.beginPath();
  ctx.arc(half, half, half, 0, Math.PI * 2);
  ctx.clip();

  ctx.fillStyle = '#4285F4'; ctx.fillRect(0,    0,    half, half); // top-left:     blue
  ctx.fillStyle = '#EA4335'; ctx.fillRect(half, 0,    half, half); // top-right:    red
  ctx.fillStyle = '#FBBC05'; ctx.fillRect(0,    half, half, half); // bottom-left:  yellow
  ctx.fillStyle = '#34A853'; ctx.fillRect(half, half, half, half); // bottom-right: green

  return ctx.getImageData(0, 0, size, size);
}

/**
 * Draws a solid-colour circle with a centred text label.
 */
export function drawIconImageData(size, label, bgColor, fgColor, createCanvas) {
  const canvas = createCanvas(size);
  const ctx = canvas.getContext('2d');
  const half = size / 2;

  // Full-size circle
  ctx.fillStyle = bgColor;
  ctx.beginPath();
  ctx.arc(half, half, half, 0, Math.PI * 2);
  ctx.fill();

  // Label — slightly larger font for single-char, smaller for two-char (index ≥ 10)
  const fontSize = label.length > 1 ? Math.round(size * 0.75) : Math.round(size * 0.90);
  ctx.fillStyle = fgColor;
  ctx.font = `bold ${fontSize}px Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const m = ctx.measureText(label);
  const y = half + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
  ctx.fillText(label, half, y);

  return ctx.getImageData(0, 0, size, size);
}
