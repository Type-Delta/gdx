import {
   CheckCache,
   CONSTS,
   MathKit,
   REGEXP,
   ex_length,
   ncc,
   strJustify,
   strWrap,
} from '@lib/Tools';
import { SGR } from '@/consts';

const _4bitColorMap = Object.entries(CONSTS.AnsiColorCodes);
const _4bitStyles = ['bright', 'dim', 'italic', 'underline', 'inverse', 'hidden'] as const;

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

export interface FormatTableOptions {
   /**
    * Padding to apply to each cell's content. Can be a single number for uniform padding or an array for directional padding (top, right, bottom, left similar to CSS padding) Defaults to 1 (one space on each side).
    */
   padding?: number[] | number;
   /**
    * Width of each column's content area (excluding cell padding). Can be a single number for uniform width or an array for per-column widths.
    * Use `'auto'` to size each column to its widest content. Defaults to `'auto'`.
    */
   columnWidth?: (number | 'auto')[] | number | 'auto';
   /**
    * Alignment for each column. Can be a single value for uniform alignment or an array for per-column alignment. Defaults to left-aligned.
    */
   columnAlign?: ('left' | 'right' | 'center')[] | ('left' | 'right' | 'center');
   /**
    * Border style to use for the table. 'ascii' uses simple +, -, | characters; 'unicode' uses box-drawing characters; 'none' produces a borderless table. Defaults to 'unicode'.
    */
   borderStyle?: 'ascii' | 'unicode' | 'none';
   /**
    * Optional ANSI color for the table borders. Can be an RgbVec or ANSI SGR string. If not provided, borders will use the default terminal color. Note: This option is ignored if `borderStyle` is set to 'none'.
    */
   borderAnsiColor?: RgbVec | string;
   /**
    * Redundancy level for ANSI-aware string operations. Higher levels provide more robust handling of complex strings (e.g., with emojis, fullwidth characters, or nested ANSI codes) at the cost of performance. Defaults to 0 (basic ANSI support without special handling). See `strWrap` documentation for details on how this affects string processing within table cells.
    */
   redundancyLv?: number;
}

/**
 * Represents the inferred ANSI styles from a string, including foreground color (`fg`), background color (`bg`), and text styles (`sp` for styles present). The `fg` and `bg` can be either an ANSI SGR string or an RgbVec depending on the context of use. The `sp` array contains style names like 'bright', 'dim', 'italic', etc., that are active in the string.
 */
export interface InferredAnsiStyle {
   fg?: string | RgbVec;
   bg?: RgbVec | string;
   sp?: string[];
}

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
 * Converts an HSL color value to RGB. Conversion formula
 * adapted from http://en.wikipedia.org/wiki/HSL_and_HSV.
 * Assumes h, s, and l are contained in the set [0, 1] and
 * returns r, g, and b in the set [0, 255].
 */
export function hslToRgbVec(h: number, s: number, l: number): RgbVec {
   let r, g, b;

   if (s === 0) {
      r = g = b = l; // achromatic
   } else {
      const hue2rgb = (p: number, q: number, t: number) => {
         if (t < 0) t += 1;
         if (t > 1) t -= 1;
         if (t < 1 / 6) return p + (q - p) * 6 * t;
         if (t < 1 / 2) return q;
         if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
         return p;
      };

      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
   }

   return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/**
 * Blends two RGB colors together with a given ratio.
 * The `ratio` parameter controls the weight of `overlay` color:
 * - `ratio = 0` returns `base` color.
 * - `ratio = 1` returns `overlay` color.
 * - Values in between produce a mix of the two colors.
 * All color components are clamped to the [0, 255] range.
 *
 * @param base - The base color as an `RgbVec`.
 * @param overlay - The overlay color as an `RgbVec`.
 * @param ratio - The blend ratio (0..1) determining the influence of the overlay color.
 */
export function colorMix(base: RgbVec, overlay: RgbVec, ratio: number): RgbVec {
   return [
      Math.round(base[0] * (1 - ratio) + overlay[0] * ratio),
      Math.round(base[1] * (1 - ratio) + overlay[1] * ratio),
      Math.round(base[2] * (1 - ratio) + overlay[2] * ratio),
   ];
}

/**
 * Creates an ANSI escape code for 24-bit foreground color.
 * Format: \x1b[38;2;R;G;Bm
 * @param rgb - RGB color values [r, g, b]
 * @returns ANSI escape code string
 */
export function fgRgb(rgb: RgbVec): string {
   return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

/**
 * Creates an ANSI escape code for 24-bit background color.
 * Format: \x1b[48;2;R;G;Bm
 * @param rgb - RGB color values [r, g, b]
 * @returns ANSI escape code string
 */
export function bgRgb(rgb: RgbVec): string {
   return `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

/**
 * Strips ANSI escape codes (SGR) from a string to get visible length.
 * @param str - String with potential ANSI codes
 * @returns String with all ANSI codes removed
 */
export function stripAnsiColor(str: string): string {
   return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Gets the visible display width of a string (excluding SGR ANSI codes).
 * @param str - String to measure
 * @returns Visible character count
 */
export function getDisplayWidth(str: string): number {
   return stripAnsiColor(str).length;
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

/**
 * Helper function to get 4-bit color name from ANSI code. Returns null if not found.
 * This is used to map ANSI SGR codes back to their color/style names for style inference.
 */
export function get4bitColorName(code: string): string | null {
   for (const [name, value] of _4bitColorMap) {
      if (value === code) {
         return name;
      }
   }
   return null;
}

/**
 * Infers the effective foreground and background colors from ANSI SGR codes in a string.
 * It processes ANSI codes in reverse order to determine the final styles, stopping at the first reset code.
 * Supports 4-bit color names and 24-bit RGB codes. Hyperlink and other non-color SGR codes are ignored.
 *
 * NOTE: This implementation still missing 8bit 256-color support
 *
 * @param str - The input string containing ANSI escape codes.
 * @returns An object with optional `fg` and `bg` properties representing the inferred foreground and background colors, `sp` for styles.
 * Colors can be returned as 4-bit color names (e.g., 'red', 'bgBlue') or as RGB tuples ([r, g, b]).
 */
export function inferAnsiStyles(str: string): InferredAnsiStyle {
   const style: { fg?: RgbVec | string; bg?: RgbVec | string; sp?: string[] } = {};
   const matches = [...str.matchAll(REGEXP.ANSICode)].reverse();

   for (const match of matches) {
      const code = match[1];
      const _4bitColor = get4bitColorName('\x1b' + code);
      if (_4bitColor) {
         if (_4bitColor === 'reset')
            break; // stop processing on reset
         else if (!style.bg && _4bitColor.startsWith('bg')) {
            style.bg = _4bitColor;
         } else if (_4bitStyles.includes(_4bitColor as (typeof _4bitStyles)[number])) {
            // prepend style to preserve order
            if (!style.sp) style.sp = [];
            style.sp.unshift(_4bitColor);
         } else {
            if (style.fg) continue; // already have a foreground color, skip
            style.fg = _4bitColor;
         }
      } else if (!style.fg && code.startsWith('[38;2;')) {
         const [r, g, b] = code
            .slice(6)
            .split(';')
            .map((n) => parseInt(n, 10));
         style.fg = [r, g, b];
      } else if (!style.bg && code.startsWith('[48;2;')) {
         const [r, g, b] = code
            .slice(6)
            .split(';')
            .map((n) => parseInt(n, 10));
         style.bg = [r, g, b];
      }
      // NOTE: hyperlinks and other non-color SGR codes are ignored for style inference
   }

   return style;
}

/**
 * Serializes a style object containing foreground/background colors and text styles into a string of ANSI escape codes.
 * - `fg` and `bg` can be either 4-bit color names (e.g., 'red', 'bgBlue') or RGB tuples ([r, g, b]).
 * - `sp` is a string of text styles (e.g., 'bright', 'underline') that will be applied in order.
 *
 * @param styles - An object with optional `fg`, `bg`, and `sp` properties representing the desired styles.
 * @returns A string containing the ANSI escape codes corresponding to the provided styles.
 */
export function serializeAnsiStyles(styles: InferredAnsiStyle): string {
   let result = '';
   if (styles.sp) {
      for (const style of styles.sp) {
         const code = CONSTS.AnsiColorCodes[style as keyof typeof CONSTS.AnsiColorCodes];
         if (code) result += code;
      }
   }
   if (styles.fg) {
      if (typeof styles.fg === 'string') {
         const code = CONSTS.AnsiColorCodes[styles.fg as keyof typeof CONSTS.AnsiColorCodes];
         if (code) result += code;
      } else {
         result += fgRgb(styles.fg);
      }
   }
   if (styles.bg) {
      if (typeof styles.bg === 'string') {
         const code = CONSTS.AnsiColorCodes[styles.bg as keyof typeof CONSTS.AnsiColorCodes];
         if (code) result += code;
      } else {
         result += bgRgb(styles.bg);
      }
   }
   return result;
}

export function formatTable(rows: string[][], options: FormatTableOptions = {}): string {
   const {
      padding = 1,
      columnWidth = 'auto',
      columnAlign = 'left',
      borderStyle = 'unicode',
      borderAnsiColor,
      redundancyLv = 0,
   } = options;

   if (!rows?.length) return '';

   const columnCount = Math.max(0, ...rows.map((row) => row?.length ?? 0));
   if (!columnCount) return '';

   const [padTop, padRight, padBottom, padLeft] = normalizePadding(padding);
   const normalizedRows = rows.map((row) =>
      new Array(columnCount).fill('').map((_, i) => String(row?.[i] ?? ''))
   );
   const normalizedAlign = normalizeAlign(columnAlign, columnCount);

   const rawCellLines = normalizedRows.map((row) => row.map((cell) => cell.split(/\r?\n/)));

   const contentWidths = new Array<number>(columnCount).fill(0);
   for (let col = 0; col < columnCount; col++) {
      for (let row = 0; row < rawCellLines.length; row++) {
         for (const line of rawCellLines[row][col]) {
            const width = ex_length(line, redundancyLv);
            if (width > contentWidths[col]) contentWidths[col] = width;
         }
      }
   }

   const normalizedWidths = normalizeColumnWidth(columnWidth, contentWidths);
   const cellLines = rawCellLines.map((row) =>
      row.map((lines, col) => {
         const width = normalizedWidths[col];
         if (width <= 0) return [''];

         const wrapped: string[] = [];
         for (const line of lines) {
            if (ex_length(line, redundancyLv) <= width) {
               wrapped.push(line);
               continue;
            }

            const wrappedLines = strWrap(line, width, {
               mode: 'strict',
               redundancyLv,
            }).split('\n');

            // Restore ANSI styles across wrapped lines to prevent style breaks
            let lastLineStyle: string | null = null;
            for (let i = 0; i < wrappedLines.length; i++) {
               if (lastLineStyle) {
                  wrappedLines[i] = lastLineStyle + wrappedLines[i];
               }
               lastLineStyle = serializeAnsiStyles(inferAnsiStyles(wrappedLines[i]));
            }

            wrapped.push(...wrappedLines);
         }
         return wrapped.length ? wrapped : [''];
      })
   );

   const cellWidths = normalizedWidths.map((w) => w + padLeft + padRight);

   const border = getBorder(borderStyle);
   const borderPrefix = getBorderPrefix(borderAnsiColor);
   const borderSuffix = borderPrefix ? SGR.reset : '';
   const colorizeBorder = (text: string) =>
      borderPrefix ? `${borderPrefix}${text}${borderSuffix}` : text;

   const out: string[] = [];

   if (border) {
      out.push(buildBorderLine('top'));
   }

   for (let rowIndex = 0; rowIndex < normalizedRows.length; rowIndex++) {
      const rowCells = cellLines[rowIndex];
      const contentHeight = Math.max(1, ...rowCells.map((lines) => lines.length));
      const totalHeight = padTop + contentHeight + padBottom;

      for (let lineIndex = 0; lineIndex < totalHeight; lineIndex++) {
         const segments: string[] = [];
         for (let col = 0; col < columnCount; col++) {
            const contentLineIndex = lineIndex - padTop;
            const rawLine =
               contentLineIndex >= 0 && contentLineIndex < rowCells[col].length
                  ? rowCells[col][contentLineIndex]
                  : '';

            const aligned = strJustify(rawLine, normalizedWidths[col], {
               align: normalizedAlign[col],
               filler: ' ',
               overflow: 'visible',
               redundancyLv,
            });
            segments.push(' '.repeat(padLeft) + aligned + ' '.repeat(padRight));
         }

         if (!border) {
            out.push(segments.join(''));
            continue;
         }

         let rowLine = colorizeBorder(border.v);
         for (let col = 0; col < segments.length; col++) {
            rowLine += segments[col];
            if (col < segments.length - 1) {
               rowLine += colorizeBorder(border.v);
            }
         }
         rowLine += colorizeBorder(border.v);
         out.push(rowLine);
      }

      if (border && rowIndex < normalizedRows.length - 1) {
         out.push(buildBorderLine('mid'));
      }
   }

   if (border) {
      out.push(buildBorderLine('bottom'));
   }

   return out.join('\n');

   function normalizePadding(value: number | number[]): [number, number, number, number] {
      if (typeof value === 'number') {
         const n = Math.max(0, Math.floor(value));
         return [n, n, n, n];
      }

      if (!value.length) return [1, 1, 1, 1];
      const v = value.map((n) => Math.max(0, Math.floor(n || 0)));
      switch (v.length) {
         case 1:
            return [v[0], v[0], v[0], v[0]];
         case 2:
            return [v[0], v[1], v[0], v[1]];
         case 3:
            return [v[0], v[1], v[2], v[1]];
         default:
            return [v[0], v[1], v[2], v[3]];
      }
   }

   function normalizeAlign(
      value: ('left' | 'right' | 'center')[] | ('left' | 'right' | 'center'),
      count: number
   ): ('left' | 'right' | 'center')[] {
      if (typeof value === 'string') {
         return new Array(count).fill(value);
      }
      return new Array(count)
         .fill('left')
         .map((_, i) => value[i] ?? value[value.length - 1] ?? 'left');
   }

   function normalizeColumnWidth(
      value: (number | 'auto')[] | number | 'auto',
      measuredWidths: number[]
   ): number[] {
      if (value === 'auto') return [...measuredWidths];

      if (typeof value === 'number') {
         const n = Math.max(0, Math.floor(value));
         return new Array(measuredWidths.length).fill(n);
      }

      return measuredWidths.map((autoWidth, i) => {
         const setting = value[i] ?? value[value.length - 1] ?? 'auto';
         if (setting === 'auto') return autoWidth;
         return Math.max(0, Math.floor(setting));
      });
   }

   function getBorder(style: 'ascii' | 'unicode' | 'none') {
      if (style === 'none') return null;
      if (style === 'ascii') {
         return {
            topLeft: '+',
            topJoin: '+',
            topRight: '+',
            leftJoin: '+',
            cross: '+',
            rightJoin: '+',
            bottomLeft: '+',
            bottomJoin: '+',
            bottomRight: '+',
            h: '-',
            v: '|',
         };
      }

      return {
         topLeft: '┌',
         topJoin: '┬',
         topRight: '┐',
         leftJoin: '├',
         cross: '┼',
         rightJoin: '┤',
         bottomLeft: '└',
         bottomJoin: '┴',
         bottomRight: '┘',
         h: '─',
         v: '│',
      };
   }

   function getBorderPrefix(color: RgbVec | string | undefined): string {
      if (!color || borderStyle === 'none') return '';
      if (typeof color === 'string') {
         if (color.includes('\x1b[')) return color;
         return ncc(color as never);
      }
      return ncc(rgbVec2decimal(color));
   }

   function buildBorderLine(kind: 'top' | 'mid' | 'bottom'): string {
      if (!border) return '';

      const left =
         kind === 'top' ? border.topLeft : kind === 'bottom' ? border.bottomLeft : border.leftJoin;
      const join =
         kind === 'top' ? border.topJoin : kind === 'bottom' ? border.bottomJoin : border.cross;
      const right =
         kind === 'top'
            ? border.topRight
            : kind === 'bottom'
              ? border.bottomRight
              : border.rightJoin;

      let line = colorizeBorder(left);
      for (let col = 0; col < cellWidths.length; col++) {
         line += colorizeBorder(border.h.repeat(cellWidths[col]));
         if (col < cellWidths.length - 1) {
            line += colorizeBorder(join);
         }
      }
      line += colorizeBorder(right);
      return line;
   }
}
