/* eslint-disable no-control-regex */
import { describe, expect, it } from 'bun:test';

import { strWrap, ex_length } from '@lib/Tools';

const red = '\x1b[31m';
const green = '\x1b[32m';
const reset = '\x1b[0m';

describe('strWrap', () => {
   it('wraps at farthest soft separator before max length', () => {
      const input = 'alpha, beta, gamma';
      const wrapped = strWrap(input, 12, { mode: 'softboundary', redundancyLv: -1 });

      expect(wrapped).toBe('alpha, beta,\ngamma');
   });

   it('prefers later separators instead of early breaks', () => {
      const input = 'alpha beta gamma';
      const maxLineLength = 10;
      const wrapped = strWrap(input, maxLineLength, { mode: 'softboundary', redundancyLv: -1 });

      expect(wrapped).toBe('alpha beta\ngamma');
   });

   it('keeps ansi color codes intact when wrapping', () => {
      const input = `${red}alpha${reset} ${green}beta${reset} gamma`;
      const wrapped = strWrap(input, 8, { mode: 'softboundary', redundancyLv: 0 });

      expect(wrapped).toContain(red);
      expect(wrapped).toContain(green);
      expect(wrapped).toContain(reset);
      const stripped = wrapped.replace(/\x1b\[[0-9;]*m/g, '');
      const lines = stripped.split('\n');
      expect(lines.length).toBeGreaterThanOrEqual(2);
   });

   it('keeps hyperlinks intact across wraps', () => {
      const link = '\x1b]8;;https://example.com/docs\x07docs\x1b]8;;\x07';
      const input = `see ${link} for more info`;
      const wrapped = strWrap(input, 12, { mode: 'softboundary', redundancyLv: 0 });

      expect(wrapped).toContain('\x1b]8;;https://example.com/docs\x07');
      expect(wrapped).toContain('docs');
      expect(wrapped).toContain('\x1b]8;;\x07');
   });

   it('wraps without splitting emoji when redundancyLv=2', () => {
      const input = 'alpha 😀 beta';
      const wrapped = strWrap(input, 7, { mode: 'softboundary', redundancyLv: 2 });

      expect(wrapped).toContain('😀');
      const lines = wrapped.split('\n');
      for (const line of lines) {
         expect(ex_length(line, 2)).toBeLessThanOrEqual(7);
      }
   });

   it('keeps fullwidth characters intact', () => {
      const input = 'alpha 漢字 beta';
      const wrapped = strWrap(input, 9, { mode: 'softboundary', redundancyLv: 1 });

      expect(wrapped).toBe('alpha 漢字\nbeta');
   });
});
