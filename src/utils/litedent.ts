/**
 * Dedent strategy for per-line indentation removal.
 *
 * - `greedy`: removes as much leading whitespace as possible per line, up to the measured indent.
 * - `strict`: removes indentation only when a line can remove the full measured indent.
 */
export type LitedentDedentMode = 'greedy' | 'strict';

/**
 * Runtime options for `litedent`.
 */
export interface LitedentOptions {
   /**
    * Trims boundary whitespace blocks only when they include a line feed.
    * Defaults to `true`.
    */
   trimWhitespace?: boolean;
   /**
    * Preserves indentation for multi-line interpolation values in tagged templates.
    * Defaults to `true`.
    */
   preserveTemplateIndent?: boolean;
   /**
    * Per-line dedent behavior.
    * Defaults to `greedy`.
    */
   dedentMode?: LitedentDedentMode;
}

interface ToInputStringResult {
   input: string;
   skipRanges?: number[];
}

interface LitedentFunction {
   (input: string): string;
   (strings: TemplateStringsArray, ...values: unknown[]): string;
   withOptions(options: LitedentOptions): LitedentFunction;
}

/**
 * Returns whether a character is classified as whitespace.
 * @param code - Character code to inspect.
 * @returns `true` when the character is whitespace.
 */
function isWhitespaceCode(code: number): boolean {
   return (
      (code >= 0x09 && code <= 0x0d) ||
      code === 0x20 ||
      code === 0xa0 ||
      code === 0x1680 ||
      (code >= 0x2000 && code <= 0x200a) ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0x202f ||
      code === 0x205f ||
      code === 0x3000 ||
      code === 0xfeff
   );
}

/**
 * Converts tagged-template input or plain input into a single string.
 *
 * When `preserveTemplateIndent` is enabled, multi-line interpolation values are
 * tracked as skip ranges so dedent will not trim whitespace that belongs to
 * those values.
 *
 * @param inputOrStrings - Direct input string or template strings array.
 * @param values - Interpolated template values.
 * @param options - Runtime options.
 * @returns Concatenated source string and optional skip ranges.
 */
function toInputString(
   inputOrStrings: string | TemplateStringsArray,
   values: unknown[],
   options: LitedentOptions
): ToInputStringResult {
   if (typeof inputOrStrings === 'string') {
      return { input: inputOrStrings };
   }

   const valueStrings = values.map((value) => String(value));
   const preserveTemplateIndent = options.preserveTemplateIndent !== false;
   const skipRanges: number[] = [];

   let result = '';
   for (let i = 0; i < inputOrStrings.length; i++) {
      result += inputOrStrings[i];
      if (i < valueStrings.length) {
         const value = valueStrings[i];
         const valueStart = result.length;
         result += value;

         if (preserveTemplateIndent && value.includes('\n')) {
            skipRanges.push(valueStart, valueStart + value.length);
         }
      }
   }

   return {
      input: result,
      skipRanges: skipRanges.length === 0 ? undefined : skipRanges,
   };
}

/**
 * Removes boundary whitespace blocks only when they include an LF.
 *
 * Leading side: trims from start through the last LF in the leading
 * whitespace block.
 *
 * Trailing side: trims from the last LF in the trailing whitespace block
 * through the end of the string.
 *
 * @param input - Source string.
 * @param skipRanges - Optional skip ranges to keep aligned with `input`.
 * @returns Boundary-trimmed string and adjusted skip ranges.
 */
function trimWhitespaceAroundBoundary(input: string, skipRanges?: number[]): ToInputStringResult {
   let start = 0;
   let end = input.length;

   let i = 0;
   let lastLeadingLf = -1;
   while (i < input.length && isWhitespaceCode(input.charCodeAt(i))) {
      if (input.charCodeAt(i) === 0x0a) {
         lastLeadingLf = i;
      }
      i++;
   }
   if (lastLeadingLf !== -1) {
      start = lastLeadingLf + 1;
   }
   if (input.charCodeAt(start) === 0x0d) {
      start++;
   }

   i = input.length - 1;
   let trailingLf = -1;
   while (i >= 0 && isWhitespaceCode(input.charCodeAt(i))) {
      if (input.charCodeAt(i) === 0x0a) {
         trailingLf = i;
         break;
      }
      i--;
   }
   if (trailingLf !== -1) {
      end = trailingLf;
      if (end > start && input.charCodeAt(end - 1) === 0x0d) {
         end--;
      }
   }

   if (start >= end) {
      return { input: '' };
   }

   const output = input.slice(start, end);
   if (skipRanges === undefined || skipRanges.length === 0) {
      return { input: output };
   }

   const trimmedRanges: number[] = [];
   for (let i = 0; i < skipRanges.length; i += 2) {
      const rangeStart = skipRanges[i];
      const rangeEnd = skipRanges[i + 1];

      if (rangeEnd <= start || rangeStart >= end) {
         continue;
      }

      trimmedRanges.push(Math.max(rangeStart, start) - start, Math.min(rangeEnd, end) - start);
   }

   return {
      input: output,
      skipRanges: trimmedRanges.length === 0 ? undefined : trimmedRanges,
   };
}

/**
 * Measures indent from the last LF before the first non-whitespace character.
 * @param input - Source string.
 * @returns Indent width used for per-line stripping.
 */
function measureBaselineIndent(input: string): number {
   let firstContentIndex = -1;
   for (let i = 0; i < input.length; i++) {
      if (!isWhitespaceCode(input.charCodeAt(i))) {
         firstContentIndex = i;
         break;
      }
   }

   if (firstContentIndex === -1) {
      return 0;
   }

   const lineStart = input.lastIndexOf('\n', firstContentIndex - 1) + 1;
   return firstContentIndex - lineStart;
}

/**
 * Removes up to a fixed amount of leading whitespace from every line.
 * @param input - Source string.
 * @param indentLength - Maximum whitespace characters to remove per line.
 * @returns Indent-trimmed string.
 */
function removeIndentByAmount(
   input: string,
   indentLength: number,
   dedentMode: LitedentDedentMode,
   skipRanges?: number[]
): string {
   if (indentLength <= 0 || input.length === 0) {
      return input;
   }

   const parts: string[] = [];
   const length = input.length;
   let skipRangeIndex = 0;

   const shouldSkipTrim = (index: number): boolean => {
      if (skipRanges === undefined || skipRanges.length === 0) {
         return false;
      }

      while (skipRangeIndex < skipRanges.length && index >= skipRanges[skipRangeIndex + 1]) {
         skipRangeIndex += 2;
      }

      return skipRangeIndex < skipRanges.length && index >= skipRanges[skipRangeIndex];
   };

   let lineStart = 0;

   while (lineStart <= length) {
      let lineEnd = input.indexOf('\n', lineStart);
      if (lineEnd === -1) {
         lineEnd = length;
      }

      let trimTo = lineStart;
      let removeCount = 0;
      while (trimTo < lineEnd && removeCount < indentLength) {
         if (shouldSkipTrim(trimTo) || !isWhitespaceCode(input.charCodeAt(trimTo))) {
            break;
         }

         trimTo++;
         removeCount++;
      }

      const canRemoveFullIndent = removeCount === indentLength;
      const nextLineStart = dedentMode === 'strict' && !canRemoveFullIndent ? lineStart : trimTo;

      parts.push(input.slice(nextLineStart, lineEnd));

      if (lineEnd === length) {
         break;
      }

      lineStart = lineEnd + 1;
   }

   return parts.join('\n');
}

/**
 * Applies lightweight indentation trimming for plain strings or template tags.
 * @param input - Normalized input string.
 * @param options - Runtime options.
 * @param skipRanges - Optional ranges excluded from leading-whitespace trimming.
 * @returns Indent-trimmed string.
 */
function applyLitedent(input: string, options: LitedentOptions, skipRanges?: number[]): string {
   const normalized =
      options.trimWhitespace === false
         ? { input, skipRanges }
         : trimWhitespaceAroundBoundary(input, skipRanges);
   const indent = measureBaselineIndent(normalized.input);
   const dedentMode = options.dedentMode ?? 'greedy';
   return removeIndentByAmount(normalized.input, indent, dedentMode, normalized.skipRanges);
}

/**
 * Creates a litedent function bound to a specific options object.
 * @param options - Default options for generated function.
 * @returns Configured litedent function.
 */
function createLitedent(options: LitedentOptions): LitedentFunction {
   const fn = ((inputOrStrings: string | TemplateStringsArray, ...values: unknown[]) => {
      const { input, skipRanges } = toInputString(inputOrStrings, values, options);
      return applyLitedent(input, options, skipRanges);
   }) as LitedentFunction;

   fn.withOptions = (nextOptions: LitedentOptions) => {
      return createLitedent({
         ...options,
         ...nextOptions,
      });
   };

   return fn;
}

/**
 * A lightweight alternative to dedent for trimming indentation from multi-line strings.
 *
 * It uses a simple algorithm that only considers the whitespace before the first non-whitespace character as the baseline indent to remove. It does not attempt to find a common indent across all lines, which allows it to preserve intentional indentation differences between lines while still removing overall leading whitespace.
 */
const litedent = createLitedent({});

export default litedent;
