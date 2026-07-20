import helpCmd from './help';
import stash from './stash';
import graph from './graph';
import stats from './stats';
import clear from './clear';
import cache from './cache';
import commit from './commit';
import gdxConfig from './gdx-config';
import nocap from './nocap';
import parallel from './parallel';
import lint from './lint';
import doctor from './doctor';
import status from './status';
import macro from './macro';
import submodule from './submodule';
import reword from './reword';
import tag from './tag';
import __completion from './__completion';
import snap from './snap';
import gh from './gh';
import history from './history';
import merge from './merge';

export default {
   __completion,
   help: helpCmd,
   stash,
   graph,
   stats,
   clear,
   cache,
   commit,
   gdxConfig,
   nocap,
   parallel,
   lint,
   doctor,
   status,
   macro,
   submodule,
   reword,
   tag,
   snap,
   gh,
   history,
   merge,
};
