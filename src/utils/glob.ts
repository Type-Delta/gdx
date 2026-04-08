import { asUnixPath } from '@/utils/path';

/**
 * Builds a matcher for gitignore-like patterns that target a single path segment.
 *
 * Supports `*` and `?`, and anchors the pattern to the full input value.
 *
 * @param pattern - Pattern string.
 * @returns Matcher function.
 */
export function buildGitignoreMatcher(pattern: string): (value: string) => boolean {
   const trimmed = pattern.trim();
   if (!trimmed) return () => false;
   if (trimmed === '*') return () => true;

   const matcher = new RegExp(`^${globToRegexBody(trimmed, { pathMode: false })}$`);
   return (value: string) => matcher.test(value);
}

/**
 * Builds a matcher for normalized relative path globs.
 *
 * Supports:
 * - `*`  => match within one path segment
 * - `?`  => match one char within one path segment
 * - `**` => match across multiple directories
 * - `**` followed by `/` => optional nested path prefix
 *
 * @param pattern - Glob pattern string.
 * @returns Matcher or null when pattern is empty after normalization.
 */
export function buildPathGlobMatcher(pattern: string): ((value: string) => boolean) | null {
   const normalized = normalizeRelativePathPattern(pattern);
   if (!normalized) return null;

   const matcher = new RegExp(`^${globToRegexBody(normalized, { pathMode: true })}$`);
   return (value: string) => matcher.test(normalizeRelativePathValue(value));
}

/**
 * Normalizes glob patterns as relative unix-like paths.
 *
 * @param pattern - Raw pattern.
 * @returns Normalized pattern.
 */
export function normalizeRelativePathPattern(pattern: string): string {
   let normalized = asUnixPath(pattern.trim());
   while (normalized.startsWith('./')) {
      normalized = normalized.slice(2);
   }
   if (normalized.startsWith('/')) {
      normalized = normalized.slice(1);
   }
   normalized = normalized.replace(/\/+$/, '');
   return normalized;
}

/**
 * Normalizes matcher input values as relative unix-like paths.
 *
 * @param value - Raw path value.
 * @returns Normalized value.
 */
export function normalizeRelativePathValue(value: string): string {
   let normalized = asUnixPath(value.trim());
   while (normalized.startsWith('./')) {
      normalized = normalized.slice(2);
   }
   if (normalized.startsWith('/')) {
      normalized = normalized.slice(1);
   }
   normalized = normalized.replace(/\/+$/, '');
   return normalized;
}

interface GlobToRegexOptions {
   pathMode: boolean;
}

/**
 * Converts a glob expression body to regex body.
 *
 * @param pattern - Normalized glob pattern.
 * @param options - Conversion options.
 * @returns Regex body string without anchors.
 */
function globToRegexBody(pattern: string, options: GlobToRegexOptions): string {
   const { pathMode } = options;
   let regex = '';

   let index = 0;
   while (index < pattern.length) {
      const char = pattern[index];

      if (char === '*') {
         const nextChar = pattern[index + 1];
         if (pathMode && nextChar === '*') {
            const afterNext = pattern[index + 2];
            if (afterNext === '/') {
               regex += '(?:.*/)?';
               index += 3;
               continue;
            }
            regex += '.*';
            index += 2;
            continue;
         }

         regex += '[^/]*';
         index += 1;
         continue;
      }

      if (char === '?') {
         regex += pathMode ? '[^/]' : '.';
         index += 1;
         continue;
      }

      if (char === '/') {
         regex += '/';
         index += 1;
         continue;
      }

      regex += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      index += 1;
   }

   return regex;
}
