import { CheckCache, MathKit } from '@lib/Tools';

/**
 * A 3- or 4-element tuple representing a color in 8-bit RGB(A) components.
 *
 * - Index 0: Red component (0-255)
 * - Index 1: Green component (0-255)
 * - Index 2: Blue component (0-255)
 * - Index 3 (optional): Alpha component (0-1 or 0-255 depending on consumer)
 *
 * @example
 * // Red
 * const red: RgbVec = [255, 0, 0];
 * // Semi-transparent blue (alpha present but ignored for ANSI coloring)
 * const blue50: RgbVec = [0, 0, 255, 0.5];
 */
export type RgbVec = [number, number, number, number?];

/**
 * Returns `text` decorated with an ANSI 24-bit gradient that interpolates
 * between `colorA` and `colorB` across the character positions defined by
 * `aPos` and `bPos`.
 *
 * Behavior details:
 * - `text` is treated as a sequence of characters; each character receives
 *   an ANSI `\x1b[38;2;<r>;<g>;<b>m` color sequence.
 * - `aPos` and `bPos` are fractional positions in the range [0, 1] that map
 *   to the start and end character indices (inclusive) of the gradient.
 *   Defaults: `aPos = 0`, `bPos = 1` (whole string).
 * - Characters before the start index receive `colorA`; characters after the
 *   end index receive `colorB`; characters within the range are linearly
 *   interpolated per-channel and clamped to [0,255]. The string is reset with
 *   `\x1b[0m` at the end.
 *
 * Important notes / edge-cases:
 * - Input color components are expected to be numeric and roughly in the
 *   0..255 range for the first three entries of `RgbVec`.
 *
 * @param text - The text to apply the gradient to.
 * @param colorA - Starting color as an `RgbVec` (treated as RGB for ANSI).
 * @param colorB - Ending color as an `RgbVec` (treated as RGB for ANSI).
 * @param aPos - Fractional start position of the gradient within `text` (0..1).
 *               Defaults to `0`.
 * @param bPos - Fractional end position of the gradient within `text` (0..1).
 *               Defaults to `1`.
 * @returns A string containing ANSI 24-bit color escape sequences that, when
 *          printed to a compatible terminal, display the requested gradient.
 *
 * @example
 * // Simple full-string gradient from red to green:
 * const out = _2PointGradient('Hello', [255,0,0], [0,255,0]);
 * console.log(out);
 */
export function _2PointGradient(
   text: string,
   colorA: RgbVec,
   colorB: RgbVec,
   aPos = 0,
   bPos = 1
): string {
   if (aPos < 0) aPos = 0;
   else if (bPos > 1) bPos = 1;
   if (!(aPos < bPos) || CheckCache.supportsColor < 3) return text; // no gradient possible

   // calculate gradient indexes
   const len = text.length;
   const startIdx = Math.floor(len * aPos);
   const endIdx = Math.floor(len * bPos);
   const range = endIdx - startIdx;

   // calculate color step deltas
   const deltaR = (colorB[0] - colorA[0]) / range;
   const deltaG = (colorB[1] - colorA[1]) / range;
   const deltaB = (colorB[2] - colorA[2]) / range;

   let result = '';
   for (let i = 0; i < len; i++) {
      if (i < startIdx) {
         result += `\x1b[38;2;${colorA[0]};${colorA[1]};${colorA[2]}m${text[i]}`;
      } else if (i >= startIdx && i <= endIdx) {
         const step = i - startIdx;
         const r = Math.round(MathKit.clamp(colorA[0] + deltaR * step, 0, 255));
         const g = Math.round(MathKit.clamp(colorA[1] + deltaG * step, 0, 255));
         const b = Math.round(MathKit.clamp(colorA[2] + deltaB * step, 0, 255));
         result += `\x1b[38;2;${r};${g};${b}m${text[i]}`;
      } else {
         result += `\x1b[38;2;${colorB[0]};${colorB[1]};${colorB[2]}m${text[i]}`;
      }
   }
   result += `\x1b[0m`; // reset
   return result;
}

export function _2PointGradientInterp(colorA: RgbVec, colorB: RgbVec, t: number): RgbVec {
   const r = MathKit.clamp(Math.round(colorA[0] + (colorB[0] - colorA[0]) * t), 0, 255);
   const g = MathKit.clamp(Math.round(colorA[1] + (colorB[1] - colorA[1]) * t), 0, 255);
   const b = MathKit.clamp(Math.round(colorA[2] + (colorB[2] - colorA[2]) * t), 0, 255);
   return [r, g, b];
}

/**
 * Returns `text` decorated with an ANSI radial gradient that radiates from a center point.
 * The gradient interpolates from `colorA` at the center to `backgroundColor` at the edges.
 *
 * Behavior details:
 * - `text` is treated as a sequence of characters; each character receives
 *   an ANSI `\x1b[38;2;<r>;<g>;<b>m` color sequence.
 * - `centerPos` is a fractional position in the range [0, 1] that determines
 *   the center of the radial gradient (defaults to 0.5, middle of string).
 * - `spread` controls the radius of the gradient in the range [0, 1].
 *   A spread of 0.3 means the gradient extends 30% of the string length from center.
 * - Characters at the center receive `colorA`; characters beyond the spread
 *   distance receive `backgroundColor`; characters within the spread are
 *   interpolated based on their distance from center.
 * - The string is reset with `\x1b[0m` at the end.
 *
 * @param text - The text to apply the radial gradient to.
 * @param colorA - Center color as an `RgbVec` (treated as RGB for ANSI).
 * @param backgroundColor - Edge/background color as an `RgbVec` (treated as RGB for ANSI).
 * @param centerPos - Fractional position of the gradient center (0..1).
 *                    Defaults to `0.5` (middle of string).
 * @param spread - Fractional radius of the gradient spread (0..1).
 *                 Defaults to `0.3`.
 * @returns A string containing ANSI 24-bit color escape sequences that, when
 *          printed to a compatible terminal, display the requested radial gradient.
 *
 * @example
 * // Radial gradient with red center fading to blue background
 * const out = radialGradient('Hello World', [255,0,0], [0,0,255], 0.5, 0.4);
 * console.log(out);
 */
export function radialGradient(
   text: string,
   colorA: RgbVec,
   backgroundColor: RgbVec,
   centerPos = 0.5,
   spread = 0.3
): string {
   if (centerPos < 0) centerPos = 0;
   else if (centerPos > 1) centerPos = 1;
   if (spread <= 0 || CheckCache.supportsColor < 3) return text; // no gradient possible

   const len = text.length;
   const centerIdx = centerPos * len;
   const spreadRadius = spread * len;

   let result = '';
   for (let i = 0; i < len; i++) {
      // Calculate distance from center
      const distance = Math.abs(i - centerIdx);

      // Calculate interpolation factor (0 at center, 1 at spread radius)
      let t = distance / spreadRadius;
      t = MathKit.clamp(t, 0, 1);

      // Interpolate between colorA and backgroundColor
      const r = Math.round(MathKit.clamp(colorA[0] + (backgroundColor[0] - colorA[0]) * t, 0, 255));
      const g = Math.round(MathKit.clamp(colorA[1] + (backgroundColor[1] - colorA[1]) * t, 0, 255));
      const b = Math.round(MathKit.clamp(colorA[2] + (backgroundColor[2] - colorA[2]) * t, 0, 255));

      result += `\x1b[38;2;${r};${g};${b}m${text[i]}`;
   }

   result += `\x1b[0m`; // reset
   return result;
}

export function rgbVec2decimal(rgb: RgbVec): number {
   const r = MathKit.clamp(Math.round(rgb[0]), 0, 255);
   const g = MathKit.clamp(Math.round(rgb[1]), 0, 255);
   const b = MathKit.clamp(Math.round(rgb[2]), 0, 255);
   return (r << 16) + (g << 8) + b;
}

/**
 * Cubic Bezier curve implementation that mimics CSS's cubic-bezier() function.
 * Calculates the eased value for a given time using cubic bezier curve with control points.
 *
 * @param t - Time value (0-1)
 * @param p1x - First control point x coordinate (0-1)
 * @param p1y - First control point y coordinate (can exceed 0-1 for bounce effects)
 * @param p2x - Second control point x coordinate (0-1)
 * @param p2y - Second control point y coordinate (can exceed 0-1 for bounce effects)
 * @returns The eased value at time t
 *
 * @example
 * // Ease-in-out (similar to CSS ease-in-out)
 * const eased = cubicBezier(0.5, 0.42, 0, 0.58, 1);
 *
 * // Ease-out (similar to CSS ease-out)
 * const eased = cubicBezier(0.5, 0, 0, 0.58, 1);
 *
 * // Custom smooth curve
 * const eased = cubicBezier(0.5, 0.25, 0.1, 0.25, 1);
 */
export function cubicBezier(t: number, p1x: number, p1y: number, p2x: number, p2y: number): number {
   // Use Newton-Raphson method to find x for given t
   const epsilon = 1e-6;
   const maxIterations = 10;

   // Binary search to find t that gives us the x we want
   let start = 0;
   let end = 1;
   let currentT = t;

   for (let i = 0; i < maxIterations; i++) {
      const currentX = cubicBezierX(currentT, p1x, p2x);
      const diff = currentX - t;

      if (Math.abs(diff) < epsilon) {
         break;
      }

      if (diff > 0) {
         end = currentT;
      } else {
         start = currentT;
      }

      currentT = (start + end) / 2;
   }

   // Calculate y value using the found t
   return cubicBezierY(currentT, p1y, p2y);
}

/**
 * Helper function to calculate x coordinate on cubic bezier curve
 */
function cubicBezierX(t: number, p1x: number, p2x: number): number {
   const oneMinusT = 1 - t;
   return 3 * oneMinusT * oneMinusT * t * p1x + 3 * oneMinusT * t * t * p2x + t * t * t;
}

/**
 * Helper function to calculate y coordinate on cubic bezier curve
 */
function cubicBezierY(t: number, p1y: number, p2y: number): number {
   const oneMinusT = 1 - t;
   return 3 * oneMinusT * oneMinusT * t * p1y + 3 * oneMinusT * t * t * p2y + t * t * t;
}

/**
 * Pre-defined easing functions using cubic-bezier curves
 */
export const Easing = {
   /** Linear interpolation (no easing) */
   linear: (t: number) => t,
   /** Ease-in: slow start */
   easeIn: (t: number) => cubicBezier(t, 0.42, 0, 1, 1),
   /** Ease-out: slow end */
   easeOut: (t: number) => cubicBezier(t, 0, 0, 0.58, 1),
   /** Ease-in-out: slow start and end */
   easeInOut: (t: number) => cubicBezier(t, 0.42, 0, 0.58, 1),
   /** Custom smooth curve */
   smooth: (t: number) => cubicBezier(t, 0.25, 0.1, 0.25, 1),
   /** Bounce effect */
   bounce: (t: number) => cubicBezier(t, 0.68, -0.55, 0.265, 1.55),
} as const;
