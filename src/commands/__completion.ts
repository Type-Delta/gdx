import { suggestArgs } from '@/modules/completion';
import { CommandStructure, GdxContext } from '@/common/types';
import global from '@/global';
import { COMMON_GIT_CMDS } from '@/consts';

import { structure as clearStructure } from './clear';
import { structure as doctorStructure } from './doctor';
import { structure as gdxConfigStructure } from './gdx-config';
import { structure as graphStructure } from './graph';
import { structure as helpStructure } from './help';
import { structure as lintStructure } from './lint';
import { structure as nocapStructure } from './nocap';
import { structure as parallelStructure } from './parallel';
import { structure as stashStructure } from './stash';
import { structure as statsStructure } from './stats';
import Logger from '@/utils/logger';

const STRUCTURE_MAP: Record<string, CommandStructure> = {
   clear: clearStructure,
   doctor: doctorStructure,
   'gdx-config': gdxConfigStructure,
   graph: graphStructure,
   help: helpStructure,
   lint: lintStructure,
   nocap: nocapStructure,
   parallel: parallelStructure,
   stash: stashStructure,
   stats: statsStructure,
};

// Shorthand aliases supported by gdx
const GDX_SHORTHANDS = [
   's',     // status
   'st',    // status (another variant)
   'co',    // checkout
   'br',    // branch
   'cmi',   // commit
   'mg',    // merge
   'pl',    // pull
   'pu',    // pull (another variant)
   'ps',    // push
   'ad',    // add
   'rv',    // revert
   'rb',    // rebase
   'lg',    // log
   'sta',   // stash
];

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

      Logger.debug(`Completion invoked with args: ${allArgs.join(' ')} (idx=${cmpIndex})`, 'completion');

      // Handle root-level completion (no command chosen yet)
      if (allArgs.length === 0 || cmpIndex === 0) {
         const prefix = allArgs[0] || '';
         const candidates = new Set<string>();

         // Add gdx custom commands
         for (const cmd of Object.keys(STRUCTURE_MAP)) {
            candidates.add(cmd);
         }

         // Add shorthand aliases
         for (const alias of GDX_SHORTHANDS) {
            candidates.add(alias);
         }

         // Add common git subcommands
         for (const gitCmd of COMMON_GIT_CMDS) {
            candidates.add(gitCmd);
         }

         // Filter by prefix and sort
         const matches = Array.from(candidates)
            .filter(c => c.startsWith(prefix))
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
            const { completions } = suggestArgs(commandArgs, argIndex, structure);

            Logger.debug(`Completion matches for command '${commandName}': ${completions.join(', ')}`, 'completion');

            // Print all completions, one per line
            for (const comp of completions) {
               process.stdout.write(`${comp}\n`);
            }

            return 0;
         }
      }

      Logger.debug(`No completion structure for command '${commandName}', or index out of range`, 'completion');

      // No custom suggestions - fallback to git (handled shell-side)
      return 0;
   } finally {
      global.logLevel = previousLogLevel;
   }
}
