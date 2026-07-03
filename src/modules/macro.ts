import path from 'path';

import * as fs from './fs';
import { MACRO_PATH, SGR } from '@/consts';
import { getCache } from '@/common/cache';
import { Err } from '@lib/Tools';

import Logger from '@/utils/logger';
import { tokenizeCommand } from './shell';
import { escapeCmdArgs, quickPrint } from '@/utils/utilities';
import { GdxContext } from '@/common/types';
import { ArgsSet } from './arguments';

export interface MacroMap {
   [name: string]: string;
}

const MACRO_CACHE_KEY = 'macro.all';
const MACRO_CACHE_TTL = 1440; // 24 hours in minutes

/**
 * Reads macros from the macro.json file.
 * @returns MacroMap or empty object if file doesn't exist or is invalid.
 */
export async function readMacrosFromFile(): Promise<MacroMap> {
   try {
      if (!fs.existsSync(MACRO_PATH)) {
         return {};
      }

      const content = await fs.readFile(MACRO_PATH, 'utf-8');
      const parsed = JSON.parse(content);

      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
         Logger.warn(`Invalid macro.json format at ${MACRO_PATH}`, 'macro');
         return {};
      }

      return parsed as MacroMap;
   } catch (err) {
      Logger.warn(`Failed to read macro.json: ${Err.from(err).message}`, 'macro');
      return {};
   }
}

/**
 * Writes macros to the macro.json file with 2-space indentation.
 * @param macros - The macro map to write.
 */
export async function writeMacrosToFile(macros: MacroMap): Promise<void> {
   try {
      const dirPath = path.dirname(MACRO_PATH);
      if (!fs.existsSync(dirPath)) {
         fs.mkdirSync(dirPath, { recursive: true });
      }

      const content = JSON.stringify(macros, null, 2);
      await fs.writeFile(MACRO_PATH, content, 'utf-8');
      Logger.debug(`Macros written to ${MACRO_PATH}`, 'macro');
   } catch (err) {
      throw new Err(`Failed to write macro.json: ${Err.from(err).message}`, 'MACRO_WRITE_FAILED');
   }
}

/**
 * Syncs macros from file to cache.
 * Throws if cache is disabled.
 */
export async function syncMacrosToCache(): Promise<void> {
   const macros = await readMacrosFromFile();
   const cache = await getCache();
   if (cache.isDisabled) {
      throw new Err('Cache is disabled. Cannot sync macros to cache.', 'CACHE_DISABLED');
   }

   await cache.set(MACRO_CACHE_KEY, macros, { maxAgeMinutes: MACRO_CACHE_TTL });
   Logger.debug(`Synced ${Object.keys(macros).length} macros to cache`, 'macro');
}

/**
 * Gets macros from cache if available, otherwise falls back to file.
 * Always updates cache after reading from file (if cache is enabled).
 * @returns MacroMap
 */
export async function getMacrosCachedOrLoad(): Promise<MacroMap> {
   const cache = await getCache();
   if (cache.isDisabled) {
      return await readMacrosFromFile();
   }

   const cached = await cache.get<MacroMap>(MACRO_CACHE_KEY);

   if (cached) {
      Logger.debug('Using cached macros', 'macro');
      return cached;
   }

   // Cache miss - read from file and cache
   const macros = await readMacrosFromFile();
   await cache.set(MACRO_CACHE_KEY, macros, { maxAgeMinutes: MACRO_CACHE_TTL });
   Logger.debug('Loaded macros from file and cached', 'macro');

   return macros;
}

/**
 * Executes a macro by running its commands sequentially through the gdx dispatcher.
 * This allows macros to invoke any gdx command, not just git commands.
 * @param git$ - Git executable path (can be array for test contexts with -C flag).
 * @param macroScript - The macro script string.
 * @param macroArgs - Arguments passed to the macro invocation.
 * @param extraFlags - Extra flags to append to the last command.
 * @returns Exit code (0 = success, non-zero = failure).
 */
export async function executeMacro(
   git$: string | string[],
   macroScript: string,
   macroArgs: string[]
): Promise<number> {
   // Split by semicolon to get individual commands
   const commands = macroScript
      .split(';')
      .map((c) => c.trim())
      .filter((c) => c.length > 0);

   if (commands.length === 0) {
      Logger.error('Macro script is empty.', 'macro');
      return 1;
   }

   // Import dispatch lazily to avoid circular dependency
   const { dispatch } = await import('@/cli/dispatch');

   for (let i = 0; i < commands.length; i++) {
      const isLastCommand = i === commands.length - 1;
      const argv = tokenizeCommand(commands[i]);

      // Substitute placeholders
      const { substituted, notUsedArgs } = substitutePlaceholders(argv, macroArgs);

      // Append extra flags to the last command
      if (isLastCommand) substituted.push(...notUsedArgs);

      if (substituted.length === 0) continue;

      quickPrint(
         SGR.dim +
         SGR.cyan +
         `▶ Executing: ${SGR.white + SGR.bright}gdx ${escapeCmdArgs(substituted).join(' ')}` +
         SGR.reset
      );

      // Create a context for this command
      const ctx: GdxContext = {
         git$,
         args: new ArgsSet(substituted),
      };

      // Dispatch through gdx routing (which handles custom commands, aliases, etc.)
      const exitCode = await dispatch(ctx, { inMacro: true });
      if (exitCode !== 0) {
         Logger.debug(`Macro command failed with exit code ${exitCode}`, 'macro');
         return exitCode;
      }
   }

   return 0;
}

/**
 * Detects if a string argument is a file path based on the following patterns:
 * - Unix: starts with `./` or `/`
 * - Windows: starts with `.\`, `<drive>:/`, or `<drive>:\`
 */
export function isFilePath(arg: string): boolean {
   if (arg.startsWith('./') || arg.startsWith('/')) {
      return true;
   }

   // Windows: .\, C:/, C:\
   if (arg.startsWith('.\\')) {
      return true;
   }

   // Windows drive letter: C:/ or C:\
   if (/^[a-zA-Z]:[/\\]/.test(arg)) {
      return true;
   }

   return false;
}

/**
 * Substitutes placeholders like $1, $2, ... in an argv array with provided arguments.
 * @param argv - The command argv array with placeholders.
 * @param macroArgs - The arguments to substitute.
 * @returns Argv array with substitutions applied.
 */
export function substitutePlaceholders(
   argv: string[],
   macroArgs: string[]
): {
   substituted: string[];
   notUsedArgs: string[];
} {
   let allArgsIndex = -1;
   const notUsedArgs: Set<string> = new Set(macroArgs);

   const substituted = argv.map((arg, i) => {
      return arg.replace(/\$(\*|\d+)/g, (match, num) => {
         if (num === '*') {
            allArgsIndex = i;
            notUsedArgs.clear();
            return '';
         }

         const index = parseInt(num, 10) - 1;
         if (index >= 0 && index < macroArgs.length) {
            notUsedArgs.delete(macroArgs[index]);
            return macroArgs[index];
         }

         return match;
      });
   });

   if (allArgsIndex !== -1) {
      // Insert all remaining args at the position of $*
      substituted.splice(allArgsIndex, 1, ...macroArgs);
   }

   return {
      substituted,
      notUsedArgs: Array.from(notUsedArgs),
   };
}
