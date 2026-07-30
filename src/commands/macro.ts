import litedent from 'litedent';

import { CommandHelpObj, CommandStructure, GdxContext } from '@/common/types';
import {
   readMacrosFromFile,
   writeMacrosToFile,
   syncMacrosToCache,
   isFilePath,
} from '@/modules/macro';
import { Err, strWrap } from '@lib/Tools';

import Logger from '@/utils/logger';
import { progressiveMatch, quickPrint } from '@/utils/utilities';
import { getCache } from '@/common/cache';
import * as fs from '@/modules/fs';
import { EXECUTABLE_NAME, GDX_VPALETTE, SGR } from '@/consts';
import { _2PointGradient } from '@/modules/graphics';
import global from '@/global';

/**
 * Main macro command dispatcher.
 */
async function macro(ctx: GdxContext): Promise<number> {
   const { args } = ctx;
   const inputCommand = args[1]?.toLowerCase();
   const { match: subCmd, candidates } = progressiveMatch(inputCommand, [
      'set',
      'list',
      'drop',
      'sync',
   ]);

   switch (subCmd) {
      case 'set':
         return await macroSet(ctx);
      case 'list':
         return await macroList();
      case 'drop':
         return await macroDrop(ctx);
      case 'sync':
         return await macroSync();
      default:
         if (candidates && candidates.length > 0) {
            Logger.warn(
               `Ambiguous command '${inputCommand}'. Did you mean one of: ${candidates.join(', ')}?`
            );
         } else {
            Logger.warn(`Unknown macro subcommand '${inputCommand}'`);
         }
         Logger.info('Available subcommands: set, list, drop, sync', 'macro');
         return 1;
   }
}

/**
 * Reads content from stdin.
 * @returns Promise<string> The content read from stdin.
 */
async function readFromStdin(): Promise<string> {
   return new Promise((resolve, reject) => {
      let data = '';
      process.stdin.setEncoding('utf-8');

      process.stdin.on('data', (chunk) => {
         data += chunk;
      });

      process.stdin.on('end', () => {
         resolve(data.trim());
      });

      process.stdin.on('error', (err) => {
         reject(err);
      });

      // If stdin is a TTY, it means there's no redirection
      if (process.stdin.isTTY) {
         resolve('');
      }
   });
}

/**
 * Sets a macro: `gdx macro set <name> <script-or-filepath>`
 * Supports stdin redirection: `gdx macro set <name> < script.txt`
 */
async function macroSet(ctx: GdxContext): Promise<number> {
   const { args } = ctx;
   const name = args[2];
   const scriptOrPath = args.slice(3);

   if (!name) {
      Logger.error('Macro name is required. Usage: gdx macro set <name> <script>', 'macro');
      return 1;
   }

   let script: string;

   // If no script arguments provided, try reading from stdin (shell redirection)
   if (scriptOrPath.length === 0) {
      try {
         script = await readFromStdin();
         if (!script) {
            Logger.error(
               'Macro script or file path is required. Use: gdx macro set <name> <script> or gdx macro set <name> < file.txt',
               'macro'
            );
            return 1;
         }
         Logger.debug('Loaded macro script from stdin', 'macro');
      } catch (err) {
         const error = Err.from(err);
         Logger.error(`Failed to read from stdin: ${error.message}`, 'macro');
         Logger.debug(error.toString(), 'macro');
         return 1;
      }
   }
   // Check if first argument is a file path
   else if (scriptOrPath.length === 1 && isFilePath(scriptOrPath[0])) {
      const filePath = scriptOrPath[0];
      try {
         if (!fs.existsSync(filePath)) {
            Logger.error(`File not found: ${filePath}`, 'macro');
            return 1;
         }
         script = (await fs.readFile(filePath, 'utf-8')).trim();
         Logger.debug(`Loaded macro script from file: ${filePath}`, 'macro');
      } catch (err) {
         const error = Err.from(err);
         Logger.error(`Failed to read file: ${error.message}`, 'macro');
         Logger.debug(error.toString(), 'macro');
         return 1;
      }
   } else {
      // Treat as literal script
      script = scriptOrPath.join(' ');
   }

   if (!script) {
      Logger.error('Macro script cannot be empty.', 'macro');
      return 1;
   }

   try {
      const macros = await readMacrosFromFile();
      const isOverwrite = name in macros;

      macros[name] = script;
      await writeMacrosToFile(macros);

      // Update cache if enabled
      const cache = await getCache();
      await cache.set('macro.all', macros, { maxAgeMinutes: 1440 });

      if (isOverwrite) {
         quickPrint(SGR.yellow + `Macro '${name}' updated.` + SGR.reset);
      } else {
         quickPrint(SGR.green + `Macro '${name}' created.` + SGR.reset);
      }

      return 0;
   } catch (err) {
      const error = Err.from(err);
      Logger.error(`Failed to set macro: ${error.message}`, 'macro');
      Logger.debug(error.toString(), 'macro');
      return 1;
   }
}

/**
 * Lists all macros: `gdx macro list`
 */
async function macroList(): Promise<number> {
   try {
      const macros = await readMacrosFromFile();

      // Update cache after reading
      const cache = await getCache();
      await cache.set('macro.all', macros, { maxAgeMinutes: 1440 });

      const names = Object.keys(macros);

      if (names.length === 0) {
         quickPrint(SGR.dim + 'No macros defined.' + SGR.reset);
         return 0;
      }

      quickPrint(SGR.cyan + SGR.bright + 'Macros:' + SGR.reset);

      for (const name of names.sort()) {
         const script = macros[name];
         const preview = script.length > 80 ? script.substring(0, 77) + '...' : script;
         // Replace newlines with space for single-line display
         const previewOneLine = preview.replace(/\s+/g, ' ');
         quickPrint(`  ${SGR.green}${name}${SGR.reset}: ${SGR.dim}${previewOneLine}${SGR.reset}`);
      }

      return 0;
   } catch (err) {
      const error = Err.from(err);
      Logger.error(`Failed to list macros: ${error.message}`, 'macro');
      Logger.debug(error.toString(), 'macro');
      return 1;
   }
}

/**
 * Drops a macro: `gdx macro drop <name>`
 */
async function macroDrop(ctx: GdxContext): Promise<number> {
   const { args } = ctx;
   const name = args[2];

   if (!name) {
      Logger.error('Macro name is required. Usage: gdx macro drop <name>', 'macro');
      return 1;
   }

   try {
      const macros = await readMacrosFromFile();

      if (!(name in macros)) {
         Logger.error(`Macro '${name}' not found.`, 'macro');
         return 1;
      }

      delete macros[name];
      await writeMacrosToFile(macros);

      // Update cache if enabled
      const cache = await getCache();
      await cache.set('macro.all', macros, { maxAgeMinutes: 1440 });

      quickPrint(SGR.yellow + `Macro '${name}' deleted.` + SGR.reset);
      return 0;
   } catch (err) {
      const error = Err.from(err);
      Logger.error(`Failed to drop macro: ${error.message}`, 'macro');
      Logger.debug(error.toString(), 'macro');
      return 1;
   }
}

/**
 * Syncs macros to cache: `gdx macro sync`
 */
async function macroSync(): Promise<number> {
   try {
      await syncMacrosToCache();
      quickPrint(SGR.green + 'Macros synced to cache.' + SGR.reset);
      return 0;
   } catch (err) {
      const error = Err.from(err);
      if (error.code === 'CACHE_DISABLED') {
         Logger.error('Cache is disabled. Cannot sync macros.', 'macro');
      } else {
         Logger.error(`Failed to sync macros: ${error.message}`, 'macro');
      }
      Logger.debug(error.toString(), 'macro');
      return 1;
   }
}

export default macro;

export const help = {
   long: () => {
      return strWrap(
         litedent`
         ${SGR.bright + _2PointGradient('MACRO', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         Define reusable gdx command sequences.

         ${SGR.bright + _2PointGradient('OVERVIEW', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         Macros are stored and executed by name:
         ${SGR.cyan}${EXECUTABLE_NAME} <name> [args]${SGR.reset}.
         They run through the gdx dispatcher, so both gdx custom commands and git commands work.

         ${SGR.bright + _2PointGradient('PLACEHOLDERS', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         - ${SGR.cyan}$1, $2, ...${SGR.reset} : positional args passed to the macro
         - ${SGR.cyan}$*${SGR.reset} : all args (consumes the rest)

         ${SGR.bright + _2PointGradient('COMMANDS', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         - set <name> <script|file>: Save a macro script.
         - list: Show macros with a short preview.
         - drop <name>: Delete a macro.
         - sync: Refresh cache from macro.json.

         ${SGR.bright + _2PointGradient('NOTES', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         - Use semicolons to chain commands.
         - You can read the script from stdin: ${SGR.cyan}${EXECUTABLE_NAME} macro set <name> < file.txt${SGR.reset}.
         - Macros cannot invoke other macros.
         `,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            mode: 'softboundary',
            indent: '  ',
         }
      );
   },
   short: 'Create and manage reusable command macros.',
   usage: () => {
      return strWrap(
         litedent`
         ${SGR.cyan}${EXECUTABLE_NAME} macro set ${SGR.dim}<name> <script|file>${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} macro set ${SGR.dim}<name> < <file>${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} macro list${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} macro drop ${SGR.dim}<name>${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} macro sync${SGR.reset}

         Examples:
            ${SGR.cyan}${EXECUTABLE_NAME} macro set qc 'ad . ; cmi -m "$1"' ${SGR.reset + SGR.dim}# Save a macro with args${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} qc "ship it" ${SGR.reset + SGR.dim}# Run macro by name${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} macro set build ./script.txt ${SGR.reset + SGR.dim}# Load from file${SGR.reset}
         `,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            mode: 'softboundary',
            indent: '  ',
         }
      );
   },
} as const satisfies CommandHelpObj;

export const structure = {
   $root: {
      set: {},
      list: {},
      drop: {},
      sync: {},
   },
} as const satisfies CommandStructure;
