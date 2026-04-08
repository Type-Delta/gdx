import * as fs from '@/modules/fs';
import { constants } from 'fs';

interface ProgressiveMatchResult {
   match: string | null;
   candidates: string[] | null;
   isExact: boolean;
}

/**
 * Quickly prints a message to stdout with a newline.
 * @param msg - The message to print.
 */
type QuickPrintWriter = (msg: string) => void;

let quickPrintWriter: QuickPrintWriter | null = null;

export function setQuickPrintWriter(writer: QuickPrintWriter | null): void {
   quickPrintWriter = writer;
}

export function quickPrint(msg: string = '', end: string = '\n'): void {
   if (quickPrintWriter) {
      quickPrintWriter(msg + end);
      return;
   }
   process.stdout.write(msg + end);
}

/**
 * Checks if a file exists and is executable.
 * @param filePath - The path to the file to check.
 * @returns A promise that resolves to `true` if the file exists and is executable, `false` otherwise.
 */
export async function isExecutable(filePath: string): Promise<boolean> {
   try {
      const stats = await fs.stat(filePath);
      if (!stats.isFile()) return false;
      await fs.access(filePath, constants.X_OK);
      return true;
   } catch {
      return false;
   }
}

/**
 * Performs progressive matching of an input string against a list of candidate strings.
 * @param input - The input string to match.
 * @param candidates - The list of candidate strings to match against.
 * @param priorityMatch - If true, prioritizes the first matching candidate when multiple matches are found.
 * @returns An object containing the matched string (if any), the list of candidates that matched, and a boolean indicating if the match was exact.
 */
export function progressiveMatch(
   input: string,
   candidates: string[],
   priorityMatch = false
): ProgressiveMatchResult {
   if (input === '') {
      return {
         match: null,
         candidates: candidates,
         isExact: false,
      };
   }

   let matchedCandidates = [];
   for (const candidate of candidates) {
      if (candidate === input) {
         return {
            match: candidate,
            candidates: null,
            isExact: true,
         };
      }

      if (candidate.startsWith(input)) {
         matchedCandidates.push(candidate);
      }
   }

   if (priorityMatch && matchedCandidates.length > 1) {
      // Prioritize lower-index candidates
      matchedCandidates = [matchedCandidates[0]];
   }

   return {
      match: matchedCandidates.length === 1 ? matchedCandidates[0] : null,
      candidates: matchedCandidates,
      isExact: matchedCandidates.includes(input),
   };
}

export function escapeCmdArgs(args: string[]): string[] {
   return args.map((arg) => {
      if (/[\s"`$\\]/.test(arg)) {
         return `"${arg.replace(/(["\\$`])/g, '\\$1')}"`;
      }
      return arg;
   });
}

export function arrDelete<T>(item: T, arr: T[]): T[] {
   const index = arr.indexOf(item);
   if (index !== -1) {
      arr.splice(index, 1);
   }
   return arr;
}

/**
 * Normalizes a path component to be safe for filesystem use
 */
export function normalizePath(pathStr: string): string {
   if (!pathStr) return '';

   return pathStr.replace(/[/\\]/g, '_').replace(/[<>:"|?*\x00-\x1f]/g, '_');
}

/**
 * No operation.
 */
export const noop = (): void => { };

/**
 * Infers a boolean value from a string. Recognizes '1', 'true', 'yes', and 'on' (case-insensitive) as true.
 * @param value - The string to infer the boolean value from.
 * @returns `true` if the string represents a true value, `false` otherwise.
 */
export function inferBool(value: string): boolean {
   const trueValues = ['1', 'true', 'yes', 'on'];
   return trueValues.includes(value.toLowerCase());
}

/**
 * Compares two semantic version strings.
 * @param v1 - First version string.
 * @param v2 - Second version string.
 * @returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal.
 */
export function compareVersions(v1: string, v2: string): number {
   const parts1 = v1.split('.').map(Number);
   const parts2 = v2.split('.').map(Number);
   const len = Math.max(parts1.length, parts2.length);
   for (let i = 0; i < len; i++) {
      const num1 = parts1[i] || 0;
      const num2 = parts2[i] || 0;
      if (num1 > num2) return 1;
      if (num1 < num2) return -1;
   }
   return 0;
}


/**
 * Routes items in an array into multiple arrays based on a sorting function.
 * @param arr The array of items to be routed.
 * @param sorter A function that determines the index of the sub-array for each item.
 * @returns An array of arrays, where each sub-array contains items routed to that index.
 */
export function routeItems<T = unknown>(
   arr: T[],
   sorter: (item: T, index: number, array: T[]) => number,
): (T[] | undefined)[] {
   const result: T[][] = [];
   let lastFilledIndex = -1;

   for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      const index = sorter(item, i, arr);
      if (!result[index]) {
         result[index] = [];

         if (lastFilledIndex + 1 < index) {
            for (let j = lastFilledIndex + 1; j < index; j++) result[j] = [];
         }
         lastFilledIndex = index;
      }
      result[index].push(item);
   }
   return result;
}
