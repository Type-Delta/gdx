import { describe, expect, it } from 'bun:test';

import { stripGitGlobalArgs } from '@/modules/arguments';

describe('stripGitGlobalArgs', () => {
   it('skips stripping when first arg is not a flag', () => {
      const result = stripGitGlobalArgs(['status', '-s'], 1);

      expect(result.args).toEqual(['status', '-s']);
      expect(result.gitArgs).toEqual([]);
      expect(result.cursorIndex).toBe(1);
      expect(result.cursorInGitGlobal).toBe(false);
   });

   it('strips leading git global options', () => {
      const result = stripGitGlobalArgs(['-C', 'repo', 'status']);

      expect(result.args).toEqual(['status']);
      expect(result.gitArgs).toEqual(['-C', 'repo']);
      expect(result.cursorInGitGlobal).toBe(false);
   });

   it('marks cursor within git global option and preserves args', () => {
      const result = stripGitGlobalArgs(['-C', 'repo', 'status'], 1);

      expect(result.args).toEqual(['-C', 'repo', 'status']);
      expect(result.gitArgs).toEqual([]);
      expect(result.cursorIndex).toBe(1);
      expect(result.cursorInGitGlobal).toBe(true);
   });
});
