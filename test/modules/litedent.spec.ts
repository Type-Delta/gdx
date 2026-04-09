import { describe, expect, it } from 'bun:test';

import litedent from '@/utils/litedent';

describe('litedent', () => {
   it('dedents template strings using first-line baseline indent', () => {
      const output = litedent`
         alpha
            beta
         gamma
      `;

      expect(output).toBe('alpha\n   beta\ngamma');
   });

   it('dedents plain strings with matching behavior', () => {
      const output = litedent('   one\n   two\n      three');

      expect(output).toBe('one\ntwo\n   three');
   });

   it('uses greedy dedent mode by default', () => {
      const output = litedent('   one\n  two\n      three');

      expect(output).toBe('one\ntwo\n   three');
   });

   it('trims boundary whitespace only when LF is present', () => {
      const output = litedent('   \n\t  foo\n  bar  \n\t ');

      expect(output).toBe('foo\nbar  ');
   });

   it('preserves boundary whitespace when trimWhitespace is false', () => {
      const keepBoundary = litedent.withOptions({ trimWhitespace: false });
      const output = keepBoundary('\n   a\n   b\n');

      expect(output).toBe('\na\nb\n');
   });

   it('removes same-count leading whitespace even with mixed whitespace types', () => {
      const output = litedent('\n\t  alpha\n  \tbeta\n \t gamma\n');

      expect(output).toBe('alpha\nbeta\ngamma');
   });

   it('preserves interpolation values and stringifies non-strings', () => {
      const output = litedent`
         value: ${42}
         object: ${{ ok: true }}
      `;

      expect(output).toBe('value: 42\nobject: [object Object]');
   });

   it('preserves multiline interpolation indentation by default', () => {
      const inserted = '      child\n        grandchild';
      const output = litedent`
         root
            ${inserted}
         end
      `;

      expect(output).toBe('root\n   ' + inserted + '\nend');
   });

   it('can disable multiline interpolation indent preservation', () => {
      const withoutPreserve = litedent.withOptions({ preserveTemplateIndent: false });
      const inserted = '      child\n        grandchild';
      const output = withoutPreserve`
         root
            ${inserted}
         end
      `;

      expect(output).toBe('root\n         child\ngrandchild\nend');
   });

   it('handles all-whitespace input', () => {
      expect(litedent('\n\t   \n')).toBe('');
      expect(litedent.withOptions({ trimWhitespace: false })('\n\t   \n')).toBe('\n\t   \n');
   });

   it('skips dedent for under-indented lines in strict mode', () => {
      const strictDedent = litedent.withOptions({ dedentMode: 'strict' });
      let output = strictDedent('   one\n  two\n      three');

      expect(output).toBe('one\n  two\n   three');

      output = strictDedent`
   one
  two
      three
      `;

      expect(output).toBe('one\n  two\n   three');
   });
});
