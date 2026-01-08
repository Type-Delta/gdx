import helpCmd from './help';
import stash from './stash';
import graph from './graph';
import stats from './stats';
import clear from './clear';
import commit from './commit';
import gdxConfig from './gdx-config';
import nocap from './nocap';
import parallel from './parallel';
import lint from './lint';
import doctor from './doctor';
import __completion from './__completion';

export default {
   __completion,
   help: helpCmd,
   stash,
   graph,
   stats,
   clear,
   commit,
   gdxConfig,
   nocap,
   parallel,
   lint,
   doctor,
};
