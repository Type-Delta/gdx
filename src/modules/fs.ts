import fs from 'fs';
import path from 'path';
import fsp from 'fs/promises';

export {
   existsSync,
   readFileSync,
   writeFileSync,
   mkdirSync,
   mkdtempSync,
   rmSync,
   accessSync,
   readdirSync,
   appendFileSync,
   unlinkSync,
   constants,
} from 'fs';

export {
   access,
   rm,
   rmdir,
   mkdir,
   readdir,
   readlink,
   stat,
   link,
   unlink,
   writeFile,
   appendFile,
   readFile,
} from 'fs/promises';

/**
 * Gets the modification time of a file in milliseconds since the UNIX epoch.
 * Returns undefined if the file does not exist or an error occurs.
 * @param filePath The path to the file.
 * @returns The modification time in milliseconds, or undefined.
 */
export async function getStatMTime(filePath: string | null): Promise<number | undefined> {
   if (!filePath) return undefined;
   try {
      if (!fs.existsSync(filePath)) return undefined;
      const stats = await fsp.stat(filePath);
      return stats.mtimeMs;
   } catch {
      return undefined;
   }
}

/**
 * Normalizes a path for reliable comparisons.
 * Expands Windows 8.3 short paths when possible.
 * @param inputPath The path to normalize.
 * @returns A normalized path string.
 */
export function normalizeSync(inputPath: string): string {
   if (!inputPath) return '';
   let resolved = inputPath;
   try {
      resolved = fs.realpathSync.native
         ? fs.realpathSync.native(inputPath)
         : fs.realpathSync(inputPath);
   } catch {
      resolved = path.resolve(inputPath);
   }

   return process.platform === 'win32'
      ? resolved.replace(/\\/g, '/').toLowerCase()
      : resolved;
}

/**
 * Checks if a child path is inside a parent directory.
 * @param parentDirPath The parent directory path.
 * @param childPath The child path to check.
 * @returns True if the child path is within the parent path.
 */
export function isChildrenOf(parentDirPath: string, childPath: string): boolean {
   const parent = normalizeSync(parentDirPath).replace(/\/+$/, '');
   const child = normalizeSync(childPath).replace(/\/+$/, '');
   if (!parent || !child) return false;
   if (child === parent) return true;
   return child.startsWith(`${parent}/`);
}
