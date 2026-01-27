import { GdxContext } from '@/common/types';
import {
   readMacrosFromFile,
   writeMacrosToFile,
   syncMacrosToCache,
   isFilePath,
} from '@/modules/macro';
import { Err, ncc } from '@lib/Tools';
import Logger from '@/utils/logger';
import { quickPrint } from '@/utils/utilities';
import { getCache } from '@/common/cache';
import * as fs from '@/modules/fs';

/**
 * Main macro command dispatcher.
 */
async function macro(ctx: GdxContext): Promise<number> {
   const { args } = ctx;
   const subCmd = args[1];

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
         Logger.error(
            `Unknown macro subcommand: '${subCmd}'. Available: set, list, drop, sync`,
            'macro'
         );
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
         Logger.error(`Failed to read from stdin: ${Err.from(err).message}`, 'macro');
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
         Logger.error(`Failed to read file: ${Err.from(err).message}`, 'macro');
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
         quickPrint(ncc('Yellow') + `Macro '${name}' updated.` + ncc());
      } else {
         quickPrint(ncc('Green') + `Macro '${name}' created.` + ncc());
      }

      return 0;
   } catch (err) {
      Logger.error(`Failed to set macro: ${Err.from(err).message}`, 'macro');
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
         quickPrint(ncc('Dim') + 'No macros defined.' + ncc());
         return 0;
      }

      quickPrint(ncc('Cyan') + ncc('Bright') + 'Macros:' + ncc());

      for (const name of names.sort()) {
         const script = macros[name];
         const preview = script.length > 80 ? script.substring(0, 77) + '...' : script;
         // Replace newlines with space for single-line display
         const previewOneLine = preview.replace(/\s+/g, ' ');
         quickPrint(`  ${ncc('Green')}${name}${ncc()}: ${ncc('Dim')}${previewOneLine}${ncc()}`);
      }

      return 0;
   } catch (err) {
      Logger.error(`Failed to list macros: ${Err.from(err).message}`, 'macro');
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

      quickPrint(ncc('Yellow') + `Macro '${name}' deleted.` + ncc());
      return 0;
   } catch (err) {
      Logger.error(`Failed to drop macro: ${Err.from(err).message}`, 'macro');
      return 1;
   }
}

/**
 * Syncs macros to cache: `gdx macro sync`
 */
async function macroSync(): Promise<number> {
   try {
      await syncMacrosToCache();
      quickPrint(ncc('Green') + 'Macros synced to cache.' + ncc());
      return 0;
   } catch (err) {
      const error = Err.from(err);
      if (error.code === 'CACHE_DISABLED') {
         Logger.error('Cache is disabled. Cannot sync macros.', 'macro');
      } else {
         Logger.error(`Failed to sync macros: ${error.message}`, 'macro');
      }
      return 1;
   }
}

export default macro;

export const structure = {
   $root: {
      set: {},
      list: {},
      drop: {},
      sync: {},
   },
};
