import path from 'path';

import * as fs from './fs';
import { MACRO_PATH } from '@/consts';
import { getCache } from '@/common/cache';
import { CacheService } from '@/common/cache';
import { Err, ncc } from '@lib/Tools';
import Logger from '@/utils/logger';
import { execGit, tokenizeCommand } from './shell';
import { escapeCmdArgs, quickPrint } from '@/utils/utilities';

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
   if (CacheService.isDisabled) {
      throw new Err('Cache is disabled. Cannot sync macros to cache.', 'CACHE_DISABLED');
   }

   const macros = await readMacrosFromFile();
   const cache = await getCache();
   await cache.set(MACRO_CACHE_KEY, macros, { maxAgeMinutes: MACRO_CACHE_TTL });
   Logger.debug(`Synced ${Object.keys(macros).length} macros to cache`, 'macro');
}

/**
 * Gets macros from cache if available, otherwise falls back to file.
 * Always updates cache after reading from file (if cache is enabled).
 * @returns MacroMap
 */
export async function getMacrosCachedOrFileFallback(): Promise<MacroMap> {
   if (CacheService.isDisabled) {
      return await readMacrosFromFile();
   }

   const cache = await getCache();
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
 * Executes a macro by expanding and running its commands sequentially.
 * @param git$ - Git executable path.
 * @param macroScript - The macro script string.
 * @param macroArgs - Arguments passed to the macro invocation.
 * @param extraFlags - Extra flags to append to the last command.
 * @returns Exit code (0 = success, non-zero = failure).
 */
export async function executeMacro(
   git$: string,
   macroScript: string,
   macroArgs: string[],
   extraFlags: string[]
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

   for (let i = 0; i < commands.length; i++) {
      const isLastCommand = i === commands.length - 1;
      let argv = tokenizeCommand(commands[i]);

      // Substitute placeholders
      argv = substitutePlaceholders(argv, macroArgs);

      // Expand shorthands
      argv = expandShorthands(argv);

      // Append extra flags to the last command
      if (isLastCommand && extraFlags.length > 0) {
         argv.push(...extraFlags);
      }

      if (argv.length === 0) continue;

      quickPrint(ncc('Cyan') + `Executing: git ${escapeCmdArgs(argv).join(' ')}` + ncc());

      const exitCode = await execGit(git$, argv);
      if (exitCode !== 0) {
         Logger.error(`Macro command failed with exit code ${exitCode}`, 'macro');
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
 * Expands gdx shorthands in a command argv array.
 * Maps shorthands like 'cmi' → 'commit', 'ad' → 'add', etc.
 * @param argv - The command argv array.
 * @returns Expanded argv array.
 */
export function expandShorthands(argv: string[]): string[] {
   if (argv.length === 0) return argv;

   const shorthandMap: Record<string, string> = {
      s: 'status',
      co: 'checkout',
      br: 'branch',
      cmi: 'commit',
      mg: 'merge',
      pl: 'pull',
      pu: 'pull',
      ps: 'push',
      ad: 'add',
      rv: 'revert',
      rb: 'rebase',
      lg: 'log',
      sta: 'stash',
   };

   const expanded = [...argv];
   if (expanded[0] in shorthandMap) {
      expanded[0] = shorthandMap[expanded[0]];
   }

   return expanded;
}

/**
 * Substitutes placeholders like $1, $2, ... in an argv array with provided arguments.
 * @param argv - The command argv array with placeholders.
 * @param macroArgs - The arguments to substitute.
 * @returns Argv array with substitutions applied.
 */
export function substitutePlaceholders(argv: string[], macroArgs: string[]): string[] {
   return argv.map((arg) => {
      return arg.replace(/\$(\d+)/g, (match, num) => {
         const index = parseInt(num, 10) - 1;
         return index >= 0 && index < macroArgs.length ? macroArgs[index] : match;
      });
   });
}
