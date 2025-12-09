import { execa } from 'execa';
import * as path from 'path';

import { isExecutable } from './utilities';

export { $ } from 'execa';

/**
 * An execa instance configured to inherit stdout/stderr from the parent process.
 */
export const $inherit = execa({ stdout: 'inherit' });


/**
 * Finds the full path of a given executable command, similar to `Bun.which()`.
 *
 * Searches in the following order:
 * 1. Direct path (if `cmd` contains separators).
 * 2. Current working directory.
 * 3. Directory of the executing script.
 * 4. Directory of the Node.js executable.
 * 5. System PATH.
 *
 * On Windows, it also checks extensions defined in `PATHEXT`.
 *
 * @param cmd - The command or executable name to find.
 * @returns A promise that resolves to the full path of the executable, or `null` if not found.
 */
export async function whichExec(cmd: string): Promise<string | null> {
   // If the command contains a path separator, check it directly
   if (cmd.includes(path.sep) || cmd.includes('/')) {
      const resolved = path.resolve(cmd);
      return (await isExecutable(resolved)) ? resolved : null;
   }

   const isWindows = process.platform === 'win32';
   let extensions: string[] = [''];

   if (isWindows) {
      // On Windows, try extensions from PATHEXT
      const pathExt = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH';
      const systemExts = pathExt.split(';').filter(Boolean);

      // If cmd has an extension, try it first (empty string), then others if needed
      // But usually if it has an extension we might just want to check that.
      // However, to be safe and mimic robust behavior, we can try appending extensions too
      // unless it matches one of the executable extensions.
      extensions = ['', ...systemExts];
   }

   const searchPaths: string[] = [];
   searchPaths.push(process.cwd());

   if (process.argv[1]) {
      searchPaths.push(path.dirname(process.argv[1]));
   }

   searchPaths.push(path.dirname(process.execPath));

   if (process.env.PATH) {
      searchPaths.push(...process.env.PATH.split(path.delimiter));
   }

   // Filter unique paths to avoid redundant checks
   const uniquePaths = [...new Set(searchPaths)];

   for (const dir of uniquePaths) {
      if (!dir) continue;
      for (const ext of extensions) {
         const fullPath = path.join(dir, cmd + ext);
         if (await isExecutable(fullPath)) {
            return fullPath;
         }
      }
   }

   return null;
}
