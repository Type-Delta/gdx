import { describe, expect, it } from 'bun:test';

import { escapeRegExp, strJustify, strLimit } from '@lib/Tools';

describe('Tools utility helpers', () => {
   it('should escape all regexp syntax characters including parentheses', () => {
      const escaped = escapeRegExp('file(name).ts?[v1]');
      const regex = new RegExp(`^${escaped}$`);

      expect(regex.test('file(name).ts?[v1]')).toBe(true);
      expect(regex.test('filename.ts?v1')).toBe(false);
   });

   it('should keep strLimit output within very small limits', () => {
      expect(strLimit('abcdef', 0)).toBe('');
      expect(strLimit('abcdef', 1)).toBe('.');
      expect(strLimit('abcdef', 2)).toBe('..');
      expect(strLimit('abcdef', 3)).toBe('...');
   });

   it('should handle spacebetween alignment with one or more segments', () => {
      expect(strJustify(['solo'], 6, { align: 'spacebetween' })).toBe('solo  ');
      expect(strJustify(['a', 'b', 'c'], 7, { align: 'spacebetween' })).toBe('a  b  c');
   });
});
