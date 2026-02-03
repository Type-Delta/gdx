import { describe, expect, it } from 'bun:test';
import { suggestArgs } from '@/modules/completion';
import { CommandStructure } from '@/common/types';

describe('Completion Engine - Multiple Suggestions', () => {
   const structure: CommandStructure = {
      $root: {
         fork: ['--move', '--mirror'],
         join: {
            $allOf: ['--keep', '--all'],
            forced: {},
         },
         simple: {},
         nested: {
            child: {
               grandchild: ['--deep'],
            },
            sibling: {},
         },
      },
   };

   it('should return all matching subcommands at root', async () => {
      // args=[], index=0. Suggest all from root.
      const result = await suggestArgs([], 0, structure, { git$: 'git' });
      expect(result.completions).toEqual(['fork', 'join', 'nested', 'simple']);
   });

   it('should return multiple filtered suggestions by prefix', async () => {
      // args=['ne'], index=0. Prefix 'ne'.
      const result = await suggestArgs(['ne'], 0, structure, { git$: 'git' });
      expect(result.completions).toEqual(['nested']);
   });

   it('should return multiple flags for subcommand', async () => {
      // args=['fork', '-'], index=1. Cursor at '-'.
      const result = await suggestArgs(['fork', '-'], 1, structure, { git$: 'git' });
      expect(result.completions).toEqual(['--move', '--mirror']);
   });

   it('should return empty array when $anyOf is exhausted', async () => {
      // args=['fork', '--move', '-'], index=2.
      const result = await suggestArgs(['fork', '--move', '-'], 2, structure, { git$: 'git' });
      expect(result.completions).toEqual([]);
   });

   it('should return all matching $allOf flags', async () => {
      // args=['join', '-'], index=1.
      const result = await suggestArgs(['join', '-'], 1, structure, { git$: 'git' });
      expect(result.completions).toEqual(['--all', '--keep']);
   });

   it('should filter out already used $allOf flags', async () => {
      // args=['join', '--all', '-'], index=2.
      const result = await suggestArgs(['join', '--all', '-'], 2, structure, { git$: 'git' });
      expect(result.completions).toEqual(['--keep']);
   });

   it('should return subcommands and flags together', async () => {
      // args=['join', ''], index=1.
      const result = await suggestArgs(['join', ''], 1, structure, { git$: 'git' });
      // Should have 'forced', '--all', '--keep'
      expect(result.completions).toEqual(['--all', '--keep', 'forced']);
   });

   it('should handle nested structures', async () => {
      // args=['nested', ''], index=1.
      const result = await suggestArgs(['nested', ''], 1, structure, { git$: 'git' });
      expect(result.completions).toEqual(['child', 'sibling']);
   });

   it('should return empty array for invalid history', async () => {
      // args=['fork', '--invalid', '-'], index=2.
      const result = await suggestArgs(['fork', '--invalid', '-'], 2, structure, { git$: 'git' });
      expect(result.completions).toEqual([]);
   });
});
