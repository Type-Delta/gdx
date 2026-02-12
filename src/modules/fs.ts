import fs from 'fs';
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
