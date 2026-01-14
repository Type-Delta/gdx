import type { CommandStructure } from '@/common/types';

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

export const STRUCTURE_MAP: Record<string, CommandStructure> = {
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
