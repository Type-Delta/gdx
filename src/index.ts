import { execa, ExecaError } from 'execa';

import { Err, ncc, yuString } from '../lib/esm/Tools';

import cmd from './commands';
import { COMMON_GIT_CMDS } from './consts';
import { $inherit, whichExec } from './modules/shell';
import { compareVersions, escapeCmdArgs, progressiveMatch, quickPrint } from './utils/utilities';
import { ArgsSet } from './modules/arguments';
import { GdxContext } from './common/types';
import { getShellScript } from './templates/shell';
import global from './global';
import { getConfig } from './common/config';
import Logger from './utils/logger';
import { getGitVersionCached, getGitConfigCached } from './modules/cache-controller';

const _args = process.argv.slice(2);

async function main(): Promise<number> {
   const ctx: GdxContext = {
      args: new ArgsSet(_args),
      git$: '',
   };
   const args = ctx.args;

   if (args[0] === '--init') {
      const shell = args.popValue('--init') || args.popValue('--shell');
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

   ctx.git$ = git$;

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

   const originalCmd = args[0];
   let redirectTo: string | null = null;
   let redirectMode: string = '>';

   AliasNCustomCmd: if (args[0]) {
      const { match, candidates } = progressiveMatch(args[0], COMMON_GIT_CMDS);

      if (match) args[0] = match;

      switch (args[0]) {
         case 's': // alias for 'status'
            args[0] = 'status';
         case 'status':
            // Handle recursive flag
            if (args.includes('-r') || args.includes('--recursive')) {
               return await cmd.status(ctx);
            }
            break;
         case 'co': // alias for 'checkout'
            args[0] = 'checkout';
            break;
         case 'br': // alias for 'branch'
            args[0] = 'branch';
            break;
         case 'cmi': // alias for 'commit'
            args[0] = 'commit';
         case 'commit':
            if (args[1] === 'auto') {
               return await cmd.commit.auto(ctx);
            }
            break;
         case 'mg': // alias for 'merge'
            args[0] = 'merge';
            break;
         case 'pl': // alias for 'pull'
         case 'pu':
            args[0] = 'pull';
         case 'pull':
            // Handle -au flag (allow-unrelated-histories)
            for (let i = 1; i < args.length; i++) {
               if (args[i] === '-au') {
                  args[i] = '--allow-unrelated-histories';
                  break;
               }
            }
            break;
         case 'lint':
            return await cmd.lint(ctx);
         case 'ps': // alias for 'push'
            args[0] = 'push';
         case 'push':
            // Check for auto-lint
            if (!args.popValue('--no-lint')) {
               const config = await getConfig();
               const behavior = config.get<string>('lint.onPushBehavior') || 'off';

               if (behavior === 'error' || behavior === 'warning') {
                  const lintResult = await cmd.lint(ctx);
                  if (lintResult !== 0) {
                     if (behavior === 'error') {
                        Logger.error('Lint failed. Push aborted.', 'lint');
                        return 1;
                     } else {
                        quickPrint(
                           ncc('Yellow') +
                              'Lint failed, but proceeding with push (warning mode).' +
                              ncc()
                        );
                     }
                  }
               }
            }
            // Handle -fl flag (force-with-lease)
            for (let i = 1; i < args.length; i++) {
               if (args[i] === '-fl') {
                  args[i] = '--force-with-lease';
                  break;
               }
            }
            break;
         case 'ad': // alias for 'add'
            args[0] = 'add';
            break;
         case 'rv': // alias for 'revert'
            args[0] = 'revert';
            break;
         case 'rb': // alias for 'rebase'
            args[0] = 'rebase';
            break;
         case 'reset':
            args[0] = 'reset';
            // Handle special reset flags
            for (let i = 1; i < args.length; i++) {
               if (args[i] === '-h') {
                  args[i] = '--hard';
                  break;
               }
               if (args[i] === '-s') {
                  args[i] = '--soft';
                  break;
               }
               // Handle '~' notation
               if (args[i] === '~') {
                  args[i] = 'HEAD';
                  break;
               }
               // Handle ~N notation (e.g., ~1, ~2)
               if (/^~\d+$/.test(args[i])) {
                  const num = args[i].substring(1);
                  args[i] = `HEAD~${num}`;
                  break;
               }
            }
            break;
         case 'log':
         case 'lg': // alias for 'log'
            if (args[0] === 'lg' && args.length === 1) {
               args.push('--oneline', '--graph', '--decorate', '--all');
            } else if (args.popOption('export', 0)) {
               // Handle 'lg export' case
               let dateFmt: string = '--date=format:"%Y-%m-%d %H:%M"';
               const hasAuthor = args.hasOption('--author', 1);

               if (!hasAuthor) {
                  args.push('--author=' + (await getGitConfigCached(git$, 'user.email')));
               }

               if (args.popValue('--relative', 1)) {
                  dateFmt = '--date=format:"%Y-%m-%d %H:%M" (%ar)';
               }

               const additionalArgs = [
                  '--all',
                  '--pretty=format:## Commit %h on [%p] - %ad%d\n%s\n\n%b\n---\n',
                  dateFmt,
               ].filter((arg) => !args.hasOption(arg, 1));
               args.push(...additionalArgs);
               redirectTo = 'gitlog_export.md';
               redirectMode = '>';
            }

            args[0] = 'log';
            break;
         case 'sta': // alias for 'stash'
            args[0] = 'stash';
         case 'stash': {
            // Sub-command order is important here (higher priority first)
            const subCommands = [
               'apply',
               'pop',
               'list',
               'drop',
               'clear',
               'show',
               'push',
               'save',
               'create',
               'store',
            ];
            const subCmdMatch = progressiveMatch(args[1] || '', subCommands, true);

            if (subCmdMatch.match) args[1] = subCmdMatch.match;
            else {
               let argEscIdx = args.indexOf('--');
               argEscIdx = argEscIdx >= 0 ? argEscIdx : args.length;
               let hasSubCmd = false;
               for (let i = 1; i < argEscIdx; i++) {
                  if (subCommands.includes(args[i])) {
                     hasSubCmd = true;
                     break;
                  }
               }

               if (!hasSubCmd) {
                  const suportsPush =
                     compareVersions(await getGitVersionCached(git$), '2.15.0') >= 0;
                  const defaultSubCmd = suportsPush ? 'push' : 'save';
                  args.splice(1, 0, defaultSubCmd); // Default to 'push' or 'save' if no sub-command
               }
            }

            if (args[1] === 'drop') {
               return await cmd.stash.drop(git$, args);
            }
            break;
         }
         case 'graph':
            return cmd.graph(ctx);
         case 'stats':
            return cmd.stats(ctx);
         case 'clear':
            return cmd.clear(ctx);
         case 'gdx-config':
            return cmd.gdxConfig(ctx);
         case 'gdx-help':
         case 'ghelp':
            return cmd.help(args[1]);
         case 'nocap':
            return cmd.nocap(ctx);
         case 'parallel':
            return cmd.parallel(ctx);
         case 'doctor':
            return cmd.doctor();
         default:
            if (candidates && candidates.length > 1) {
               Logger.warn(
                  `Ambiguous command '${originalCmd}'. Did you mean: ${candidates.join(', ')}?`
               );
               break AliasNCustomCmd;
            }
      }
   }

   if (args[0] !== originalCmd) {
      quickPrint(
         ncc('Cyan') + `Command auto expanded to: git ${escapeCmdArgs(args).join(' ')}` + ncc()
      );
   }

   return execGit(git$, args, redirectTo, redirectMode);
}

/**
 * Executes a git command with given arguments.
 *
 * Handles optional output redirection and error.
 * @param git$ Git executable path or command
 * @param args Arguments to pass to git
 * @param redirectTo Optional file path to redirect stdout
 * @param redirectMode Redirection mode: '>' (overwrite) or '>>' (append)
 * @returns Exit code of the git command
 */
async function execGit(
   git$: string,
   args: string[],
   redirectTo: string | null = null,
   redirectMode: string = '>'
): Promise<number> {
   let exitCode: number | undefined = 0;
   try {
      if (redirectTo) {
         const { exitCode: eCode } = await execa({
            stdout: {
               file: redirectTo,
               append: redirectMode === '>>',
            },
            stderr: 'inherit',
         })`${git$} ${args}`;
         exitCode = eCode;
      } else {
         const { exitCode: eCode } = await $inherit`${git$} ${args}`;
         exitCode = eCode;
      }
   } catch (_err) {
      const err = Err.from(_err);
      if (err.name === ExecaError.name && err.message.startsWith('Command failed'))
         return exitCode || 1; // git command failed, return exit code

      Logger.error('Command failed.\n' + yuString(err, { color: true }));
      return 1;
   }

   return exitCode ?? 0;
}

(async () => {
   try {
      const exitCode = await main();
      if (global.finalStringOutput) {
         quickPrint(global.finalStringOutput);
      }

      process.exit(global.exitCodeOverride >= 0 ? global.exitCodeOverride : exitCode);
   } catch (err) {
      Logger.error(yuString(err, { color: true }));
      process.exit(1);
   }
})();
