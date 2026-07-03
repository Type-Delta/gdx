import { describe, expect, it } from 'bun:test';

import { normalizeExitCode } from '@/utils/utilities';

describe('normalizeExitCode', () => {
   it('preserves integer command results', () => {
      expect(normalizeExitCode(0)).toBe(0);
      expect(normalizeExitCode(128)).toBe(128);
      expect(normalizeExitCode(-1)).toBe(-1);
   });

   it('uses an integer fallback for absent or invalid results', () => {
      expect(normalizeExitCode(undefined)).toBe(1);
      expect(normalizeExitCode(null)).toBe(1);
      expect(normalizeExitCode(Number.NaN, 1)).toBe(1);
      expect(normalizeExitCode(1.5, 1)).toBe(1);
   });

   it('rejects a non-integer fallback', () => {
      expect(() => normalizeExitCode(undefined, Number.NaN)).toThrow(
         'Exit-code fallback must be an integer.'
      );
   });
});
