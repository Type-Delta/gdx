import type { CommandStructure } from '@/common/types';

import { structure as cacheStructure } from './cache';
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
import { structure as statusStructure } from './status';
import { structure as macroStructure } from './macro';
import { structure as submoduleStructure } from './submodule';

/**
 * command structure for command extensions that doesn't a dedicated source file
 */
export const GIT_EXTENSION_STRUCTURE: Record<string, CommandStructure> = {
   commit: {
      $root: {
         auto: {
            $anyOf: ['--no-commit', '--copy', '--yes'],
         },
      },
   },
   push: {
      $root: {
         $anyOf: ['-fl', '--no-lint'],
      },
   },
   pull: {
      $root: {
         $anyOf: ['-au'],
      },
   },
   status: {
      $root: {
         $anyOf: ['--recursive', '-r'],
      },
   },
   log: {
      $root: {
         $anyOf: ['--author', '--relative'],
      },
   },
};

export const STRUCTURE_MAP: Record<string, CommandStructure> = {
   ...GIT_EXTENSION_STRUCTURE,
   cache: cacheStructure,
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
   status: statusStructure,
   macro: macroStructure,
   submodule: submoduleStructure,
};

export const GDX_SHORTHANDS = [
   's', // status
   'st', // status (another variant)
   'co', // checkout
   'br', // branch
   'cmi', // commit
   'mg', // merge
   'pl', // pull
   'pu', // pull (another variant)
   'ps', // push
   'ad', // add
   'rv', // revert
   'rb', // rebase
   'lg', // log
   'sta', // stash
] as const;

export const GDX_GLOBAL_FLAGS = ['--loglevel', '--ghelp', '--bypass', '--no-enhance'] as const;
