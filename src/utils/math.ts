/**
 * ### Create a range of numbers or filled array
 * Generates an array of numbers within a specified range, or creates an array of any length filled with a custom value.
 * @param start The starting number of the range (inclusive). If only one argument is provided, this is treated as the stop value and start defaults to 0.
 * @param stop The ending number of the range (exclusive). If not provided, start is treated as the stop value and start defaults to 0.
 * @param step The increment between each number in the range. Defaults to 1.
 * @param fill Optional value to fill the array with. If provided, all elements will be this value instead of the range numbers.
 * The fill value can be of any type except `undefined`. Its behavior is as follows:
 * - If `null` is provided, all elements will be `null`.
 * - If a function is provided, it will be called with the current index to generate each element.
 * - If an object is provided, each element will be a shallow copy of that object.
 * - Other types will be used as-is for all elements.
 *
 * @return An array of numbers from start to stop (incremented by step), or an array filled with the specified value.
 *
 * @example
 * range(5); // returns [0, 1, 2, 3, 4]
 * range(2, 5); // returns [2, 3, 4]
 * range(0, 10, 2); // returns [0, 2, 4, 6, 8]
 * range(3, undefined, 1, null); // returns [null, null, null]
 * range(5, undefined, 1, { x: 0, y: 0 }); // returns [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]
 */
// Overloads (order matters): function overload first to ensure correct inference
export function range<R>(
   start: number,
   stop: number | undefined,
   step: number | undefined,
   fill: (i: number) => R
): R[];
export function range(start: number, stop?: number, step?: number): number[];
export function range<T = number>(start: number, stop?: number, step?: number, fill?: T): T[];
export function range(start: number, stop?: number, step: number = 1, fill?: unknown): unknown[] {
   if (stop === undefined) {
      stop = start;
      start = 0;
   }

   if (step === 0)
      throw new Error('Step parameter cannot be zero as it would create an infinite loop.');

   const result: unknown[] = [];
   for (let i = start; i < stop; i += step) {
      let fillValue: unknown = i;

      if (fill !== undefined) {
         if (fill === null) fillValue = null;
         else if (typeof fill === 'function') fillValue = fill(i);
         else if (typeof fill === 'object') fillValue = { ...(fill as object) };
         else fillValue = fill;
      }

      result.push(fillValue);
   }
   return result;
}
