import { afterAll, describe, expect, it } from 'bun:test';
import {
   _2PointGradient,
   _2PointGradientInterp,
   Easing,
   bgRgb,
   colorMix,
   cubicBezier,
   fgRgb,
   formatTable,
   get4bitColorName,
   getDisplayWidth,
   hslToRgbVec,
   inferAnsiStyles,
   radialGradient,
   rgbVec2decimal,
   serializeAnsiStyles,
   stripAnsiColor,
} from '@/modules/graphics';
import { CheckCache, ncc } from '@lib/Tools';

describe('graphics module', async () => {
   const originalSupportsColor = CheckCache.supportsColor;
   CheckCache.supportsColor = 3;
   afterAll(() => {
      CheckCache.supportsColor = originalSupportsColor;
   });

   describe('inferAnsiStyles', () => {
      it('should infer ANSI styles from a string', () => {
         const input = `${ncc('Red')}Some red ${ncc('Bright')}text${ncc('BgGreen')} with green ${ncc('Underline')}background`;

         const expected: ReturnType<typeof inferAnsiStyles> = {
            fg: 'red',
            bg: 'bggreen',
            sp: ['bright', 'underline'],
         };

         const result = inferAnsiStyles(input);
         expect(result).toEqual(expected);
      });

      it('should infer ANSI styles from a string (24-bit)', () => {
         const input = `${ncc('Red')}Some red ${ncc('Bright')}text${ncc(0x00ff24, 'bg')} with green ${ncc('Dim')}background`;

         const expected: ReturnType<typeof inferAnsiStyles> = {
            fg: 'red',
            bg: [0, 255, 36],
            sp: ['bright', 'dim'],
         };

         const result = inferAnsiStyles(input);
         expect(result).toEqual(expected);
      });

      it('should infer ANSI styles from a string (24-bit complex)', () => {
         const input = `\u001b[48;2;29;29;43m\u001b[38;2;127;132;156m ${ncc('Italic')}4547 \u001b[38;2;147;153;178m  \u001b[48;2;30;30;46m${ncc('Italic')}\u001b[38;2;147;153;178m complex test`;

         const expected: ReturnType<typeof inferAnsiStyles> = {
            fg: [147, 153, 178],
            bg: [30, 30, 46],
            sp: ['italic', 'italic'],
         };

         const result = inferAnsiStyles(input);
         expect(result).toEqual(expected);
      });

      it('should ignore hyperlink ANSI sequences while inferring styles', () => {
         const input = `\x1b]8;;https://example.com\x07link\x1b]8;;\x07${ncc('Green')} text`;

         expect(inferAnsiStyles(input)).toEqual({
            fg: 'green',
         });
      });

      it('should return empty style object for plain text', () => {
         expect(inferAnsiStyles('no style here')).toEqual({});
      });
   });

   describe('serializeAnsiStyles', () => {
      it('should recreate correct ANSI styles', () => {
         const input = `${ncc('Red')}Some red ${ncc('Bright')}text${ncc('BgGreen')} with green ${ncc('Underline')}background`;

         const expected: ReturnType<typeof inferAnsiStyles> = {
            fg: 'red',
            bg: 'bggreen',
            sp: ['bright', 'underline'],
         };

         const inferred = inferAnsiStyles(input);
         expect(inferred, 'inferAnsiStyles() should correctly infer ANSI styles').toEqual(expected);

         const serialized = serializeAnsiStyles(inferred);
         const reInferred = inferAnsiStyles(serialized + 'Test'); // Append text to ensure styles are applied
         expect(
            reInferred,
            'serializeAnsiStyles() should produce ANSI codes that infer the same styles'
         ).toEqual(expected);
      });

      it('should recreate correct ANSI styles (24-bit)', () => {
         const input = `${ncc('Red')}Some red ${ncc('Bright')}text${ncc(0x00ff24, 'bg')} with green ${ncc('Dim')}background`;

         const expected: ReturnType<typeof inferAnsiStyles> = {
            fg: 'red',
            bg: [0, 255, 36],
            sp: ['bright', 'dim'],
         };

         const inferred = inferAnsiStyles(input);
         expect(inferred, 'inferAnsiStyles() should correctly infer ANSI styles').toEqual(expected);

         const serialized = serializeAnsiStyles(inferred);
         const reInferred = inferAnsiStyles(serialized + 'Test'); // Append text to ensure styles are applied
         expect(
            reInferred,
            'serializeAnsiStyles() should produce ANSI codes that infer the same styles'
         ).toEqual(expected);
      });

      it('should serialize style order and ignore unknown style entries', () => {
         const serialized = serializeAnsiStyles({
            sp: ['bright', 'unknown-style', 'underline'],
            fg: 'red',
            bg: 'bggreen',
         });

         expect(serialized).toBe(
            `${ncc('Bright')}${ncc('Underline')}${ncc('Red')}${ncc('BgGreen')}`
         );
      });

      it('should serialize RGB foreground and background styles', () => {
         const serialized = serializeAnsiStyles({
            fg: [1, 2, 3],
            bg: [4, 5, 6],
         });

         expect(serialized).toBe(`\x1b[38;2;1;2;3m\x1b[48;2;4;5;6m`);
      });
   });

   describe('color conversion and helpers', () => {
      it('should map 4-bit ANSI codes to color names', () => {
         expect(get4bitColorName(ncc('Red'))).toBe('red');
         expect(get4bitColorName('\x1b[999m')).toBeNull();
      });

      it('should convert RGB vectors to decimal with rounding and clamping', () => {
         expect(rgbVec2decimal([255, 128, 0])).toBe(0xff8000);
         expect(rgbVec2decimal([255.7, -10, 300])).toBe(0xff00ff);
      });

      it('should convert HSL to RGB for chromatic and achromatic values', () => {
         expect(hslToRgbVec(0, 1, 0.5)).toEqual([255, 0, 0]);
         expect(hslToRgbVec(0.3, 0, 0.25)).toEqual([64, 64, 64]);
      });

      it('should mix colors with ratio boundaries and midpoint', () => {
         expect(colorMix([10, 20, 30], [200, 210, 220], 0)).toEqual([10, 20, 30]);
         expect(colorMix([10, 20, 30], [200, 210, 220], 1)).toEqual([200, 210, 220]);
         expect(colorMix([0, 0, 0], [255, 255, 255], 0.5)).toEqual([128, 128, 128]);
      });

      it('should generate ANSI color codes and strip them correctly', () => {
         const styled = `${fgRgb([10, 20, 30])}${bgRgb([1, 2, 3])}AB${ncc('Reset')}`;

         expect(styled).toContain('\x1b[38;2;10;20;30m');
         expect(styled).toContain('\x1b[48;2;1;2;3m');
         expect(stripAnsiColor(styled)).toBe('AB');
         expect(getDisplayWidth(styled)).toBe(2);
      });
   });

   describe('gradient functions', () => {
      it('should return plain text when linear gradient is invalid or color support is disabled', () => {
         expect(_2PointGradient('text', [255, 0, 0], [0, 0, 255], 1, 0)).toBe('text');

         CheckCache.supportsColor = 2;
         expect(_2PointGradient('text', [255, 0, 0], [0, 0, 255])).toBe('text');
         CheckCache.supportsColor = 3;
      });

      it('should apply a linear gradient across configured range', () => {
         const output = _2PointGradient('ABCD', [255, 0, 0], [0, 0, 255], 0.25, 0.75);

         expect(output).toContain('\x1b[38;2;255;0;0mA');
         expect(output).toContain('\x1b[38;2;128;0;128mC');
         expect(output).toContain('\x1b[38;2;0;0;255mD');
         expect(output.endsWith('\x1b[0m')).toBe(true);
      });

      it('should interpolate and clamp 2-point gradient RGB values', () => {
         expect(_2PointGradientInterp([10, 20, 30], [20, 30, 40], 0.5)).toEqual([15, 25, 35]);
         expect(_2PointGradientInterp([250, 250, 250], [255, 255, 255], 2)).toEqual([
            255, 255, 255,
         ]);
      });

      it('should return plain text when radial gradient spread is invalid or color support is disabled', () => {
         expect(radialGradient('text', [255, 0, 0], [0, 0, 255], 0.5, 0)).toBe('text');

         CheckCache.supportsColor = 2;
         expect(radialGradient('text', [255, 0, 0], [0, 0, 255], 0.5, 0.5)).toBe('text');
         CheckCache.supportsColor = 3;
      });

      it('should apply a radial gradient from center to edges', () => {
         const output = radialGradient('ABCDE', [255, 0, 0], [0, 0, 255], 0.4, 0.4);

         expect(output).toContain('\x1b[38;2;0;0;255mA');
         expect(output).toContain('\x1b[38;2;255;0;0mC');
         expect(output).toContain('\x1b[38;2;0;0;255mE');
         expect(output.endsWith('\x1b[0m')).toBe(true);
      });
   });

   describe('easing utilities', () => {
      it('should evaluate cubic bezier boundaries and linear behavior', () => {
         expect(cubicBezier(0, 0.42, 0, 0.58, 1)).toBeCloseTo(0, 6);
         expect(cubicBezier(1, 0.42, 0, 0.58, 1)).toBeCloseTo(1, 6);
         const linearSample = cubicBezier(0.25, 0, 0, 1, 1);
         expect(linearSample).toBeGreaterThan(0.24);
         expect(linearSample).toBeLessThan(0.26);
      });

      it('should keep easing presets pinned at 0 and 1', () => {
         const easingFns = Object.values(Easing);

         for (const easing of easingFns) {
            expect(easing(0)).toBeCloseTo(0, 6);
            expect(easing(1)).toBeCloseTo(1, 6);
         }
      });
   });

   describe('formatTable', () => {
      it('should render an ASCII table with deterministic spacing', () => {
         const output = formatTable(
            [
               ['A', 'B'],
               ['CC', 'D'],
            ],
            {
               borderStyle: 'ascii',
               padding: 0,
               columnWidth: [2, 1],
               columnAlign: 'left',
            }
         );

         expect(output).toBe(['+--+-+', '|A |B|', '+--+-+', '|CC|D|', '+--+-+'].join('\n'));
      });

      it('should render borderless table with right alignment', () => {
         const output = formatTable(
            [
               ['1', '2'],
               ['22', '333'],
            ],
            {
               borderStyle: 'none',
               padding: 0,
               columnWidth: [2, 3],
               columnAlign: 'right',
            }
         );

         expect(output).toBe([' 1  2', '22333'].join('\n'));
      });

      it('should preserve multiline cell content across row height', () => {
         const output = formatTable([['A\nB']], {
            borderStyle: 'ascii',
            padding: 0,
            columnWidth: 1,
         });

         expect(output).toBe(['+-+', '|A|', '|B|', '+-+'].join('\n'));
      });

      it('should apply ANSI border color without affecting cell content', () => {
         const output = formatTable([['A']], {
            borderStyle: 'unicode',
            padding: 0,
            borderAnsiColor: [255, 0, 0],
         });

         expect(output).toContain('\x1b[38;2;255;0;0m');
         expect(stripAnsiColor(output)).toBe(['┌─┐', '│A│', '└─┘'].join('\n'));
      });
   });
});
