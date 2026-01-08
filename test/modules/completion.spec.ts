import { describe, expect, it } from 'bun:test';
import { suggestArg } from '@/modules/completion';
import { CommandStructure } from '@/common/types';

describe('Completion Engine', () => {
   const structure: CommandStructure = {
      $root: {
         fork: ['--move', '--mirror'],
         join: {
            $allOf: ['--keep', '--all'],
            forced: {}
         },
         simple: {},
         nested: {
            child: {
               grandchild: ['--deep']
            },
            sibling: {}
         }
      }
   };

   it('should suggest subcommands at root', () => {
      // args=[], index=0. Suggest from root.
      // Candidates: fork, join, simple, nested.
      // Shortest: fork.
      const result = suggestArg([], 0, structure);
      expect(result.completion).toBe('fork');
   });

   it('should filter suggestions by prefix', () => {
      // args=['jo'], index=0. Prefix 'jo'.
      const result = suggestArg(['jo'], 0, structure);
      expect(result.completion).toBe('join');
   });

   it('should suggest flags for subcommand', () => {
      // args=['fork', '-'], index=1. Cursor at '-'.
      const result = suggestArg(['fork', '-'], 1, structure);
      expect(result.completion).toBe('--move');
   });

   it('should respect $anyOf exclusivity', () => {
      // args=['fork', '--move', '-'], index=2.
      // --move consumed. AnyOf locked.
      const result = suggestArg(['fork', '--move', '-'], 2, structure);
      expect(result.completion).toBe(null);
   });

   it('should suggest $allOf flags', () => {
      // args=['join', '-'], index=1.
      // --all (5), --keep (6).
      const result = suggestArg(['join', '-'], 1, structure);
      expect(result.completion).toBe('--all');
   });

   it('should allow multiple $allOf flags', () => {
      // args=['join', '--all', '-'], index=2.
      // --all consumed. --keep available.
      const result = suggestArg(['join', '--all', '-'], 2, structure);
      expect(result.completion).toBe('--keep');
   });

   it('should reject invalid flags', () => {
      // --invalid is not in structure.
      const result = suggestArg(['fork', '--invalid', '-'], 2, structure);
      expect(result.completion).toBe(null);
   });

   it('should ignore positional args and stay at node', () => {
      // "fork myfork -"
      // myfork is unknown but positional. Stay at fork.
      // fork has --move.
      const result = suggestArg(['fork', 'myfork', '-'], 2, structure);
      expect(result.completion).toBe('--move');
   });

   it('should traverse nested subcommands', () => {
      // "nested child grandchild -"
      const result = suggestArg(['nested', 'child', 'grandchild', '-'], 3, structure);
      expect(result.completion).toBe('--deep');
   });

   it('should suggest child commands alongside options', () => {
      // join has 'forced' child and flags.
      // "join f"
      const result = suggestArg(['join', 'f'], 1, structure);
      expect(result.completion).toBe('forced');
   });

   it('should accumulate $allOf from parent', () => {
      // Not strictly tested in this structure (parent keys don't define $allOf)
      // Let's create a specialized structure for inheritance
      const deepStructure: CommandStructure = {
         $root: {
            parent: {
               $allOf: ['--global'],
               child: {
                  $allOf: ['--local']
               }
            }
         }
      };
      // parent child -
      const result = suggestArg(['parent', 'child', '-'], 2, deepStructure);
      // Should have --global and --local.
      // --local (7), --global (8).
      expect(result.completion).toBe('--local');

      const result2 = suggestArg(['parent', 'child', '--lo'], 2, deepStructure);
      expect(result2.completion).toBe('--local');

      const result3 = suggestArg(['parent', 'child', '--gl'], 2, deepStructure);
      expect(result3.completion).toBe('--global');
   });
});
