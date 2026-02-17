import { suggestArgs } from '@/modules/completion';
import { GdxContext } from '@/common/types';
import global from '@/global';
import { GDX_COMMANDS } from '@/consts';
import Logger from '@/utils/logger';

import { GDX_GLOBAL_FLAGS, GDX_SHORTHANDS, STRUCTURE_MAP } from './__completion.structure';

function parseIndex(totalArgs: number): number {
   const raw = process.env.GDX_CMP_IDX;
   let idx = Number.parseInt(raw || '', 10);

   if (!Number.isInteger(idx) || idx < 0) {
      idx = Math.max(0, totalArgs - 1);
   }

   if (totalArgs > 0 && idx >= totalArgs) {
      idx = totalArgs - 1;
   }

   return idx;
}

export default async function completion(ctx: GdxContext): Promise<number> {
   const previousLogLevel = global.logLevel;
   global.logLevel = 'off';

   try {
      const allArgs = [...ctx.args];
      if (allArgs[0] === '__completion') {
         allArgs.shift();
      }

      const cmpIndex = parseIndex(allArgs.length);

      Logger.debug(
         `Completion invoked with args: ${allArgs.join(' ')} (idx=${cmpIndex})`,
         'completion'
      );

      // Handle root-level completion (no command chosen yet)
      if (allArgs.length === 0 || cmpIndex === 0) {
         const prefix = allArgs[0] || '';
         const candidates = new Set<string>();

         // Add gdx custom commands
         for (const cmd of Object.keys(STRUCTURE_MAP)) { // TODO: some custom commands have progressive match, which breaks current structure-based completion
            candidates.add(cmd);
         }

         // Add shorthand aliases
         for (const alias of GDX_SHORTHANDS) {
            candidates.add(alias);
         }

         // Add global flags
         for (const flag of GDX_GLOBAL_FLAGS) {
            candidates.add(flag);
         }

         // Add common git subcommands
         for (const gitCmd of GDX_COMMANDS) {
            candidates.add(gitCmd);
         }

         // Filter by prefix and sort
         const matches = Array.from(candidates)
            .filter((c) => c.startsWith(prefix))
            .sort((a, b) => a.length - b.length || a.localeCompare(b));

         Logger.debug(`Completion root-level matches: ${matches.join(', ')}`, 'completion');

         // Print all matches, one per line
         for (const match of matches) {
            process.stdout.write(`${match}\n`);
         }

         return 0;
      }

      const commandName = allArgs[0];
      const commandArgs = allArgs.slice(1);
      const structure = STRUCTURE_MAP[commandName];

      // If we have a structure for this command, suggest from it
      if (structure) {
         const argIndex = cmpIndex - 1;
         if (argIndex >= 0 && argIndex < commandArgs.length) {
            const { completions } = await suggestArgs(commandArgs, argIndex, structure, {
               git$: ctx.git$,
            });

            Logger.debug(
               `Completion matches for command '${commandName}': ${completions.join(', ')}`,
               'completion'
            );

            // Print all completions, one per line
            for (const comp of completions) {
               process.stdout.write(`${comp}\n`);
            }

            return 0;
         }
      }

      Logger.debug(
         `No completion structure for command '${commandName}', or index out of range`,
         'completion'
      );

      // No custom suggestions - fallback to git (handled shell-side)
      return 0;
   } finally {
      global.logLevel = previousLogLevel;
   }
}
