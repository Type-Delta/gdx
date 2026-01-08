import { suggestArg } from '@/modules/completion';
import { CommandStructure, GdxContext } from '@/common/types';
import global from '@/global';

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

async function fallbackToGit(): Promise<number> {
   // TODO: find a way to actually get git's completion suggestions
   return 0;
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

      if (allArgs.length === 0) {
         return await fallbackToGit();
      }

      const commandName = allArgs[0];
      const commandArgs = allArgs.slice(1);
      const structure = STRUCTURE_MAP[commandName];

      if (!structure) {
         return await fallbackToGit();
      }

      const argIndex = cmpIndex - 1;
      if (argIndex < 0 || argIndex >= commandArgs.length) {
         return await fallbackToGit();
      }

      const { completion } = suggestArg(commandArgs, argIndex, structure);
      if (completion) {
         process.stdout.write(`${completion}\n`);
         return 0;
      }

      return await fallbackToGit();
   } finally {
      global.logLevel = previousLogLevel;
   }
}
