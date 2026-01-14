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

   it('should return all matching subcommands at root', () => {
      // args=[], index=0. Suggest all from root.
      const result = suggestArgs([], 0, structure);
      expect(result.completions).toEqual(['fork', 'join', 'nested', 'simple']);
   });

   it('should return multiple filtered suggestions by prefix', () => {
      // args=['ne'], index=0. Prefix 'ne'.
      const result = suggestArgs(['ne'], 0, structure);
      expect(result.completions).toEqual(['nested']);
   });

   it('should return multiple flags for subcommand', () => {
      // args=['fork', '-'], index=1. Cursor at '-'.
      const result = suggestArgs(['fork', '-'], 1, structure);
      expect(result.completions).toEqual(['--move', '--mirror']);
   });

   it('should return empty array when $anyOf is exhausted', () => {
      // args=['fork', '--move', '-'], index=2.
      const result = suggestArgs(['fork', '--move', '-'], 2, structure);
      expect(result.completions).toEqual([]);
   });

   it('should return all matching $allOf flags', () => {
      // args=['join', '-'], index=1.
      const result = suggestArgs(['join', '-'], 1, structure);
      expect(result.completions).toEqual(['--all', '--keep']);
   });

   it('should filter out already used $allOf flags', () => {
      // args=['join', '--all', '-'], index=2.
      const result = suggestArgs(['join', '--all', '-'], 2, structure);
      expect(result.completions).toEqual(['--keep']);
   });

   it('should return subcommands and flags together', () => {
      // args=['join', ''], index=1.
      const result = suggestArgs(['join', ''], 1, structure);
      // Should have 'forced', '--all', '--keep'
      expect(result.completions).toEqual(['--all', '--keep', 'forced']);
   });

   it('should handle nested structures', () => {
      // args=['nested', ''], index=1.
      const result = suggestArgs(['nested', ''], 1, structure);
      expect(result.completions).toEqual(['child', 'sibling']);
   });

   it('should return empty array for invalid history', () => {
      // args=['fork', '--invalid', '-'], index=2.
      const result = suggestArgs(['fork', '--invalid', '-'], 2, structure);
      expect(result.completions).toEqual([]);
   });
});
