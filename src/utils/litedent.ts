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
    * Per-line dedent behavior.
    * Defaults to `greedy`.
    */
   dedentMode?: LitedentDedentMode;
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
 * @param inputOrStrings - Direct input string or template strings array.
 * @param values - Interpolated template values.
 * @returns Concatenated source string.
 */
function toInputString(inputOrStrings: string | TemplateStringsArray, values: unknown[]): string {
   if (typeof inputOrStrings === 'string') {
      return inputOrStrings;
   }

   let result = '';
   for (let i = 0; i < inputOrStrings.length; i++) {
      result += inputOrStrings[i];
      if (i < values.length) {
         result += String(values[i]);
      }
   }

   return result;
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
 * @returns Boundary-trimmed string.
 */
function trimWhitespaceAroundBoundary(input: string): string {
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
   }

   if (start >= end) {
      return '';
   }

   return input.slice(start, end);
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
   dedentMode: LitedentDedentMode
): string {
   if (indentLength <= 0 || input.length === 0) {
      return input;
   }

   const parts: string[] = [];
   const length = input.length;
   let lineStart = 0;

   while (lineStart <= length) {
      let lineEnd = input.indexOf('\n', lineStart);
      if (lineEnd === -1) {
         lineEnd = length;
      }

      let trimTo = lineStart;
      let removeCount = 0;
      while (
         trimTo < lineEnd &&
         removeCount < indentLength &&
         isWhitespaceCode(input.charCodeAt(trimTo))
      ) {
         trimTo++;
         removeCount++;
      }

      const canRemoveFullIndent = removeCount === indentLength - 1;
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
 * @returns Indent-trimmed string.
 */
function applyLitedent(input: string, options: LitedentOptions): string {
   const normalized =
      options.trimWhitespace === false ? input : trimWhitespaceAroundBoundary(input);
   const indent = measureBaselineIndent(normalized);
   const dedentMode = options.dedentMode ?? 'greedy';
   return removeIndentByAmount(normalized, indent, dedentMode);
}

/**
 * Creates a litedent function bound to a specific options object.
 * @param options - Default options for generated function.
 * @returns Configured litedent function.
 */
function createLitedent(options: LitedentOptions): LitedentFunction {
   const fn = ((inputOrStrings: string | TemplateStringsArray, ...values: unknown[]) => {
      const input = toInputString(inputOrStrings, values);
      return applyLitedent(input, options);
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
