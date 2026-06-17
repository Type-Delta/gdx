import { beforeAll, describe, expect, it } from 'bun:test';

import {
   fuzzyMatch,
   highlightMatchRanges,
   MATCH_HIGHLIGHT_BG,
   preloadFuzzy,
} from '@/modules/fuzzy-search';

const BG = MATCH_HIGHLIGHT_BG;
const RESUME = '\x1b[49m';

describe('fuzzy-search module', () => {
   describe('highlightMatchRanges', () => {
      it('wraps a single matched range in the highlight background', () => {
         expect(highlightMatchRanges('hello', [0, 2])).toBe(`${BG}he${RESUME}llo`);
      });

      it('returns the input unchanged when there are no ranges', () => {
         expect(highlightMatchRanges('hello', [])).toBe('hello');
      });

      it('restores the provided resume background after a match', () => {
         expect(highlightMatchRanges('hello', [0, 2], '\x1b[40m')).toBe(`${BG}he\x1b[40mllo`);
      });

      it('counts visible characters only, passing ANSI SGR through untouched', () => {
         const colored = '\x1b[31mab\x1b[39mcd';
         // highlight the visible characters at offsets [2, 4): "cd"
         expect(highlightMatchRanges(colored, [2, 4])).toBe(`\x1b[31mab\x1b[39m${BG}cd${RESUME}`);
      });

      it('handles multiple disjoint ranges', () => {
         expect(highlightMatchRanges('abcdef', [0, 1, 4, 5])).toBe(
            `${BG}a${RESUME}bcd${BG}e${RESUME}f`
         );
      });
   });

   describe('fuzzyMatch', () => {
      beforeAll(async () => {
         await preloadFuzzy();
      });

      it('returns matched indices in ascending document order', () => {
         const haystack = ['the quick brown', 'fox jumps', 'over the lazy dog', 'quick fix'];
         expect(fuzzyMatch(haystack, 'quick').idx).toEqual([0, 3]);
      });

      it('returns highlight ranges aligned to each matched line', () => {
         const haystack = ['alpha beta', 'beta gamma'];
         const { idx, ranges } = fuzzyMatch(haystack, 'beta');
         expect(idx.length).toBe(2);

         const firstLine = idx.indexOf(0);
         const [start, end] = ranges[firstLine];
         expect(haystack[0].slice(start, end)).toBe('beta');
      });

      it('returns an empty result for an empty needle', () => {
         expect(fuzzyMatch(['a', 'b'], '').idx).toEqual([]);
      });
   });
});
