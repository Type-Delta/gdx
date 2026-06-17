import { ANSI_SGR_REGEX, CATPPUCCIN_VPALETTE } from '@/consts';
import { bgRgb, colorMix } from './graphics';

/**
 * In-memory fuzzy search used by the pager command palette. Backed by
 * `@leeoniya/ufuzzy`, which is kept external and lazy-loaded so it stays off the
 * CLI startup path (call {@link preloadFuzzy} while preparing the pager).
 */

type UFuzzyModule = typeof import('@leeoniya/ufuzzy');
type UFuzzyInstance = InstanceType<UFuzzyModule['default']>;

let instance: UFuzzyInstance | null = null;
let loadPromise: Promise<void> | null = null;

/**
 * Consistent background applied to every matched span so matches are uniformly
 * easy to spot regardless of the underlying line's coloring.
 */
export const MATCH_HIGHLIGHT_BG = bgRgb(
   colorMix(CATPPUCCIN_VPALETTE.base, CATPPUCCIN_VPALETTE.yellow, 0.5)
);
/** Background restored after a match span when the caller passes no resume color. */
const DEFAULT_RESUME_BG = '\x1b[49m';

/**
 * Result of a fuzzy filter: matched haystack indices (document order, ascending)
 * with their per-match highlight ranges aligned by position.
 */
export interface FuzzyResult {
   /** Matched haystack indices, ascending. */
   idx: number[];
   /** Highlight ranges per match as `[start0, end0, start1, end1, ...]` char offsets. */
   ranges: number[][];
}

/**
 * Lazily loads and instantiates the fuzzy matcher. Safe to call repeatedly and
 * concurrently; the underlying module is imported at most once.
 */
export async function preloadFuzzy(): Promise<void> {
   if (instance) return;
   loadPromise ??= import('@leeoniya/ufuzzy').then((mod) => {
      const UFuzzy = mod.default;
      instance = new UFuzzy();
   });
   await loadPromise;
}

/**
 * Filters `haystack` by `needle`, returning matched indices in document order
 * with highlight ranges. Returns an empty result when the needle is empty or the
 * matcher has not been preloaded via {@link preloadFuzzy}.
 * @param haystack - Lines to search (plain text).
 * @param needle - The search query.
 */
export function fuzzyMatch(haystack: string[], needle: string): FuzzyResult {
   if (!instance || !needle || haystack.length === 0) return { idx: [], ranges: [] };
   const idxs = instance.filter(haystack, needle);
   if (!idxs || idxs.length === 0) return { idx: [], ranges: [] };
   const info = instance.info(idxs, haystack, needle);
   return { idx: info.idx, ranges: info.ranges };
}

/**
 * Overlays {@link MATCH_HIGHLIGHT_BG} onto the visible characters of `text` at the
 * given plain-character offsets. ANSI SGR sequences in `text` are passed through
 * untouched (the highlight background is re-asserted after each so it survives
 * fg/style changes), so existing foreground colors are preserved. The caller must
 * ensure `ranges` were computed against a plain string whose characters align 1:1
 * with the visible characters of `text`.
 * @param text - Plain or ANSI-styled string to highlight.
 * @param ranges - Flat `[start, end)` char-offset pairs to highlight.
 * @param resumeBg - Background SGR to restore after each matched span. Defaults to
 *   the terminal's default background. The highlight is applied before the line's
 *   own background is prepended, so the caller passes the line background here.
 */
export function highlightMatchRanges(
   text: string,
   ranges: number[],
   resumeBg = DEFAULT_RESUME_BG
): string {
   if (ranges.length === 0) return text;

   let out = '';
   let visible = 0;
   let cursor = 0;
   let rangePtr = 0;
   let inMatch = false;

   while (cursor < text.length) {
      if (text[cursor] === '\x1b') {
         const sgr = text.slice(cursor).match(ANSI_SGR_REGEX);
         if (sgr) {
            out += sgr[0];
            if (inMatch) out += MATCH_HIGHLIGHT_BG; // keep the highlight bg over style changes
            cursor += sgr[0].length;
            continue;
         }
      }

      if (!inMatch && rangePtr < ranges.length && visible === ranges[rangePtr]) {
         out += MATCH_HIGHLIGHT_BG;
         inMatch = true;
      }

      const codePoint = text.codePointAt(cursor);
      if (codePoint === undefined) break;
      const char = String.fromCodePoint(codePoint);
      out += char;
      visible++;
      cursor += char.length;

      if (inMatch && visible === ranges[rangePtr + 1]) {
         out += resumeBg;
         inMatch = false;
         rangePtr += 2;
      }
   }

   if (inMatch) out += resumeBg;
   return out;
}
