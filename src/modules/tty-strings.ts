import stringWidth from '@node/tty-strings/src/stringWidth';
import { sliceChars } from '@node/tty-strings/src/sliceString';
import type { AnsiEscape } from '@node/tty-strings/src/utils';
// NOTE: v If this import fails, make sure bun patch is properly applied and that the `wrapLine` function is exported in `node_modules/tty-strings/src/wordWrap.ts`
import { wrapLine } from '@node/tty-strings/src/wordWrap';

import { strWrap } from '@lib/Tools';

interface stringJustifyOptions {
   /**
    * Character to fill the `target`. Defaults to a space character.
    */
   filler?: string;
   /**
    * Alignment of the string within the justified result. Defaults to `'center'`.
    * - `'left'`: Align the string to the left, padding on the right.
    * - `'right'`: Align the string to the right, padding on the left.
    * - `'center'`: Center the string, padding evenly on both sides (if an odd number of filler characters is needed, the extra character will be added to the right side).
    * - `'spacebetween'`: Only applicable when `str` is an array of strings. Distributes filler characters evenly between each string in the array, with no padding at the start or end of the result.
    */
   align?: 'left' | 'right' | 'center' | 'spacebetween';
   /**
    * How to handle cases where the visual width of `str` exceeds the specified `length`. Defaults to `'hidden'`.
    * - `'hidden'`: Truncate the string to fit the target length without any indication that it has been truncated.
    * - `'visible'`: Do not truncate the string, even if it exceeds the target length.
    * - `'collapse'`: Shorten the string to fit the target length while leaving an indication (e.g. `[...]`) that it has been truncated. The location of the collapse indication is determined by the `collapseLocation` option.
    */
   overflow?: 'hidden' | 'visible' | 'collapse';
   /**
    * When `overflow` is set to `'collapse'`, this option determines the location of the collapse indication (e.g. `[...]`) within the justified string. Defaults to `'end'`.
    */
   collapseLocation?: 'start' | 'mid' | 'end';
}

interface StringWrapOptions {
   /**
    * String or number of spaces to indent each line. Defaults to an empty string (no indentation).
    */
   indent?: string | number;
   /**
    * String or number of spaces to indent the first line. Defaults to the same value as `indent` (or no indentation if `indent` is not specified).
    */
   firstIndent?: string | number;
   /**
    * Mode to use when wrapping lines that exceed the specified width. Defaults to `'softboundary'`.
    */
   mode?: 'strict' | 'softboundary';
   /**
    * Redundancy level for string width calculations (supports `-1`: none, `0`: ANSI code, `>=1`: non-ASCII characters). Higher levels provide more accurate width calculations but can be slower. Defaults to `0`.
    */
   redundancyLv?: number;
}

/**
 * justify the string to the given length with the given options. Similar to `String.padStart()` and `String.padEnd()`, but with more options and support for ANSI color codes and wide characters.
 * @param str string to justify, can be an array of strings which will be joined together before justifying
 * @param length target length of the justified string (in terms of visual width in terminal)
 * @param options justification options
 * @returns justified string with the specified length and alignment, with ANSI color codes preserved and wide characters properly accounted for
 */
function stringJustify(str: string | string[], length: number, options: stringJustifyOptions = {}) {
   const {
      filler = ' ',
      align = 'center',
      overflow = 'hidden',
      collapseLocation = 'end',
   } = options;
   const isArr = str instanceof Array;
   const joinedStr = isArr ? str.join('') : str;
   const strLen = stringWidth(joinedStr);

   if (strLen > length) {
      if (overflow == 'collapse') return stringLimit(joinedStr, length, collapseLocation);
      if (overflow == 'hidden') return sliceChars(joinedStr, 0, length);
      return joinedStr;
   }

   switch (align) {
      case 'spacebetween':
         if (isArr) {
            if (str.length < 2) return joinedStr + filler.repeat(length - strLen);
            const gapCount = str.length - 1;
            const totalPadding = length - strLen;
            const basePadding = Math.floor(totalPadding / gapCount);
            let extraPadding = totalPadding % gapCount;

            return str.reduce((acc, cur, i) => {
               if (i == 0) return acc;
               const padding = basePadding + (extraPadding-- > 0 ? 1 : 0);
               return acc + filler.repeat(padding) + cur;
            }, str[0]);
         } // if not Array, fall through to default
      default:
      case 'center': {
         const padding = Math.ceil((length - strLen) / 2);
         return filler.repeat(padding) + joinedStr + filler.repeat(length - strLen - padding);
      }
      case 'right':
         if (strLen >= length) return joinedStr;
         return filler.repeat(length - strLen) + joinedStr;
      case 'left':
         if (strLen >= length) return joinedStr;
         return joinedStr + filler.repeat(length - strLen);
   }
}

/**limit string length, similar to Tools.strLimit but with better handling non-ASCII characters
 * @param str
 * @param limit max string length allowed
 * @param dropLocation 'mid', 'start' or 'end' determine location in which the string would
 * be dropped if the given str's length is smaller then `length`
 */
function stringLimit(str: string, limit: number, dropLocation: 'mid' | 'start' | 'end' = 'mid') {
   const strLen = stringWidth(str);

   if (strLen <= limit) return str;

   // the length of str that won't be removed
   if (limit <= 3) return sliceChars('...', 0, limit);

   const leftoverAmu = limit - 3;
   switch (dropLocation) {
      default:
         throw new Error(`'${dropLocation}' is not a valid location type.`);
      case 'mid': {
         const haft_loa = leftoverAmu >> 1;
         return (
            sliceChars(str, 0, haft_loa) +
            '...' +
            sliceChars(str, strLen - (leftoverAmu - haft_loa))
         );
      }
      case 'end':
         return sliceChars(str, 0, leftoverAmu) + '...';
      case 'start':
         return '...' + sliceChars(str, strLen - leftoverAmu);
   }
}

/**
 * Wrap a string to a specified width, taking into account ANSI escape codes and non-ASCII characters. Supports options for indentation and wrapping mode.
 *
 * This is a wrapper for the `wrapLine()` function (force exported) from the `tty-strings` library and `Tools.strWrap()`, with additional handling for redundancy levels in string width calculations.
 * If `redundancyLv` is set to 1 or higher, it will use the `wrapLine()` function which properly accounts for ANSI codes and wide characters.
 * If `redundancyLv` is 0 or less, it will fall back to `Tools.strWrap()`, which is significantly faster but less accurate for certain characters.
 *
 * @param str The string to wrap.
 * @param maxWidth The maximum width of each line (in terms of visual width in terminal).
 * @param options Wrapping options, including indentation and wrapping mode.
 * @returns The wrapped string with appropriate indentation and preserved ANSI codes.
 */
function stringWrap(str: string, maxWidth: number, options: StringWrapOptions = {}) {
   // eslint-disable-next-line prefer-const
   let { indent = '', firstIndent = null, mode = 'softboundary', redundancyLv = 0 } = options;
   str = String(str);

   if (redundancyLv < 1)
      return strWrap(str, maxWidth, options);

   if (typeof firstIndent == 'number') firstIndent = ''.padEnd(firstIndent, ' ');
   if (typeof indent == 'number') indent = ''.padEnd(indent, ' ');

   // initialize an ansi escapes stack, items are in the form [seq, isLink, close, [ix, iy]]
   const ansiStack: AnsiEscape<readonly [number, number]>[] = [];
   // ensure input is a string type
   return str
      // split into lines
      .split(/\r?\n/g)
      // wrap each line
      .map((line, i) => {
         const wrapped = wrapLine(ansiStack, line, maxWidth, mode === 'strict', false);
         let indentStart = 0;

         if (firstIndent !== null && i === 0) {
            wrapped[0] = (firstIndent as string) + wrapped[0];
            indentStart = 1;
         }
         if (indent) {
            for (let j = indentStart; j < wrapped.length; j++)
               wrapped[j] = (indent as string) + wrapped[j];
         }
         return wrapped.join('\n');
      })
      // rejoin each wrapped line
      .join('\n');
}

export default {
   stringWidth,
   sliceChars,
   stringJustify,
   stringWrap,
   stringLimit,
};
