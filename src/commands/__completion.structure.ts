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
import { structure as rewordStructure } from './reword';
import { structure as tagStructure } from './tag';
import { structure as snapStructure } from './snap';
import { structure as ghStructure } from './gh';

/**
 * command structure for command extensions that doesn't a dedicated source file
 */
export const GIT_EXTENSION_STRUCTURE: Record<string, CommandStructure> = {
   commit: {
      $root: {
         auto: {
            $anyOf: ['--no-commit', '--copy', '--yes', '--describe', '-d', '--preview'],
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
   diff: {
      $root: {
         $anyOf: ['--json'],
      },
   },
   show: {
      $root: {
         $anyOf: ['--json'],
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
   reword: rewordStructure,
   tag: tagStructure,
   snap: snapStructure,
   gh: ghStructure,
};
