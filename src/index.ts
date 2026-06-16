import { Err, yuString } from '../lib/esm/Tools';

import cmd from './commands';
import { execGit, whichExec } from './modules/shell';
import { quickPrint } from './utils/utilities';
import { ArgsSet, stripGitGlobalArgs } from './modules/arguments';
import { GdxContext } from './common/types';
import { getShellScript } from './templates/shell';
import global from './global';
import Logger from './utils/logger';
import { dispatch } from './cli/dispatch';
import { getConfig, resolveLocalConfigPathFromGit } from './common/config';

const _args = process.argv.slice(2);

Logger.debug(`Raw arguments: ${yuString(process.argv)}`, 'gdx');

async function main(): Promise<number> {
   const gitGlobalParse = stripGitGlobalArgs(_args);
   const ctx: GdxContext = {
      args: new ArgsSet(gitGlobalParse.args),
      git$: '',
   };
   const args = ctx.args;
   Logger.debug(`Parsed arguments: ${yuString(args.toArray())}`, 'gdx');

   if (args[0] === '--init') {
      const shell = args.popValue('--shell') || args.popValue('--init');
      const cmdAlias = args.popValue('--cmd');

      if (shell) {
         try {
            const script = getShellScript(shell, cmdAlias || undefined);
            quickPrint(script);
            return 0;
         } catch (err) {
            Logger.error(yuString(err, { color: true }));
            return 1;
         }
      } else {
         Logger.error(
            '<shell-name> is not specified. --init <shell-name> is required for initialization.'
         );
         return 1;
      }
   }

   // Completion must be ultra-fast: avoid whichExec('git')
   if (args[0] === '__completion') {
      return await cmd.__completion({ ...ctx, git$: 'git' });
   }

   const git$ = await whichExec('git');
   if (!git$) {
      throw new Err('Git is not installed or not found in PATH.', 'GIT_NOT_FOUND');
   }

   ctx.git$ = gitGlobalParse.gitArgs.length ? [git$, ...gitGlobalParse.gitArgs] : git$;

   if (args[0] === 'gh') {
      const gh$ = await whichExec('gh');
      if (!gh$) {
         throw new Err('GitHub CLI is not installed or not found in PATH.', 'GH_NOT_FOUND');
      }
      return cmd.gh(ctx, gh$);
   }

   if (args[0] === '--bypass') {
      // Bypass gdx and execute git directly
      return execGit(git$, args.slice(1));
   }

   // Handle global --loglevel option
   const logLevelValue = args.popValue('--loglevel');
   if (logLevelValue) {
      const validLogLevels = ['fatal', 'error', 'warn', 'info', 'debug'];
      if (validLogLevels.includes(logLevelValue)) {
         global.logLevel = logLevelValue as 'fatal' | 'error' | 'warn' | 'info' | 'debug';
      } else {
         Logger.error(
            `Invalid log level '${logLevelValue}'. Expected: ${validLogLevels.join(', ')}`
         );
         return 1;
      }
   }

   if (
      args.includes('--ghelp') ||
      args.includes('-gh') ||
      args.includes('--gdx-help') ||
      args.length === 0
   ) {
      cmd.help();
      return 0;
   }

   const config = await getConfig();
   config.setLocalConfigPath(await resolveLocalConfigPathFromGit(ctx.git$));
   global.threadResources.setMax(config.get<number>('maxThreadWorkers') || 1);

   // Dispatch to main routing logic
   return dispatch(ctx);
}

(async () => {
   try {
      const exitCode = await main();
      if (global.finalStringOutput) {
         quickPrint(global.finalStringOutput);
      }

      Logger.flushLogs();
      process.exit(global.exitCodeOverride >= 0 ? global.exitCodeOverride : exitCode);
   } catch (err) {
      Logger.error(yuString(err, { color: true }));
      Logger.flushLogs();
      process.exit(1);
   }
})();
