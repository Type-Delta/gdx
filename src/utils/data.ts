import { toShortNum } from '@lib/Tools';

/**
 * Converts a byte size into a human-readable string with appropriate units (B, KiB, MiB, etc.).
 * @param bytes - The size in bytes to convert.
 * @param maxFractionDigits - The maximum number of decimal places to include in the output (default is 1).
 * @param floor - If true, the number will be rounded down to the nearest whole number (default is false).
 * @returns A string representing the byte size in a human-readable format.
 */
export function toShortBytes(
   bytes: number,
   maxFractionDigits: number = 1,
   floor: boolean = false
): string {
   if (bytes < 1024) return `${bytes}B`;
   return toShortNum(bytes, maxFractionDigits, 1024, floor) + 'iB';
}
