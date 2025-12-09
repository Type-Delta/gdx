
import * as fs from 'fs/promises';
import { constants } from 'fs';

/**
 * Quickly prints a message to stdout with a newline.
 * @param msg - The message to print.
 */
export function quickPrint(msg: string) {
   process.stdout.write(`${msg}\n`);
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
