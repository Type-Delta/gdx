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

export const STRUCTURE_MAP: Record<string, CommandStructure> = {
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

export const GDX_GLOBAL_FLAGS = ['--loglevel', '--ghelp', '--bypass'] as const;
