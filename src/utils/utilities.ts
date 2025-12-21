
import * as fs from 'fs/promises';
import { constants } from 'fs';

interface ProgressiveMatchResult {
   match: string | null;
   candidates: string[] | null;
   isExact: boolean;
}

const _process = process;
export { _process };

/**
 * Quickly prints a message to stdout with a newline.
 * @param msg - The message to print.
 */
export function quickPrint(msg: string, end: string = '\n'): void {
   _process.stdout.write(msg + end);
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


export function progressiveMatch(input: string, candidates: string[]): ProgressiveMatchResult {
   const matchedCandidates = [];
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

   return {
      match: matchedCandidates.length === 1 ? matchedCandidates[0] : null,
      candidates: matchedCandidates,
      isExact: matchedCandidates.includes(input),
   }
}


export function escapeCmdArgs(args: string[]): string[] {
   return args.map(arg => {
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

   return pathStr
      .replace(/[/\\]/g, '_')
      .replace(/[<>:"|?*\x00-\x1f]/g, '_');
}
