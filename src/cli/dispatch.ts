import { Err, ncc } from '@lib/Tools';

import cmd from '@/commands';
import { GDX_COMMANDS, SGR } from '@/consts';
import { $, execGit } from '@/modules/shell';
import { compareVersions, escapeCmdArgs, progressiveMatch, quickPrint } from '@/utils/utilities';
import { GdxContext } from '@/common/types';
import { getConfig } from '@/common/config';
import Logger from '@/utils/logger';
import { getMacrosCachedOrLoad } from '@/modules/macro';
import { hslToRgbVec, rgbVec2decimal } from '@/modules/graphics';
import {
   getGitVersionCached,
   getGitConfigCached,
   expandRelativeRef,
   expandShowRevisionPathRefs
} from '@/modules/git';
import {
   canUseDiffViewer,
   isGitDiffOutput,
   parseDiffOutput,
   viewDiff,
   INDEX_REVISION,
   WORKING_TREE_REVISION,
} from '@/modules/diff-viewer';
import {
   buildShowBlobNavigationPlan,
   isGitShowCommitOutput,
   viewInteractiveShow,
   viewInteractiveShowBlob,
} from '@/modules/show-navigation';

/**
 * State passed through dispatch calls to track execution context.
 */
export interface DispatchState {
   /**
    * Whether we're currently inside a macro execution.
    * When true, macro expansion is disabled to prevent recursion.
    */
   inMacro: boolean;
}

/**
 * Main command router for gdx.
 * Handles aliases, custom commands, macro expansion, and fallback to git.
 * @param ctx - The GdxContext with git$ and args.
 * @param argv - The command arguments to route.
 * @param state - The dispatch state tracking execution context.
 * @returns Exit code (0 = success, non-zero = failure).
 */
export async function dispatch(
   ctx: GdxContext,
   state: DispatchState = { inMacro: false }
): Promise<number> {
   const args = ctx.args;
   const originalArgs = args.slice(0);

   // Check if the command is a macro (only if not already in a macro)
   if (!state.inMacro) {
      const macros = await getMacrosCachedOrLoad();
      if (args[0] && args[0] in macros) {
         const macroName = args[0];
         const macroScript = macros[macroName];
         const macroArgs = args.slice(1);

         quickPrint(
            SGR.dim +
            SGR.magenta +
            `※ ${SGR.white + SGR.bright} Executing macro '${macroName}'...` +
            SGR.reset
         );

         // Import executeMacro lazily to avoid circular dependency
         const { executeMacro } = await import('@/modules/macro');
         return await executeMacro(ctx.git$, macroScript, macroArgs);
      }
   } else {
      // Inside a macro - check if trying to invoke another macro
      const macros = await getMacrosCachedOrLoad();
      if (args[0] && args[0] in macros) {
         Logger.error(
            `Macro '${args[0]}' cannot be invoked from inside a macro. Macro composition is not allowed.`,
            'macro'
         );
         return 1;
      }
   }

   let redirectTo: string | null = null;
   let redirectMode: string = '>';
   const noEnhancedOutput = !args.popOption('--no-enhance');

   AliasNCustomCmd: if (args[0]) {
      const { match, candidates } = progressiveMatch(args[0], GDX_COMMANDS);

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
         case 'submodule': {
            const subCommands = [
               'switch',
               'update',
               'status',
               'add',
               'sync',
               'summary',
               'deinit',
               'foreach',
            ];
            const subCmdMatch = progressiveMatch(args[1] || '', subCommands, true);
            switch (subCmdMatch.match) {
               case 'switch':
                  return await cmd.submodule.switch(ctx);
               case 'update':
               case 'add':
               case 'deinit': {
                  const forceQuiet = !!args.popOption('--quiet');
                  args[1] = subCmdMatch.match;
                  const userSubmoduleResult = await cmd.submodule.handleUserCommand(
                     ctx,
                     args.slice(1),
                     forceQuiet
                  );
                  if (typeof userSubmoduleResult === 'number') {
                     return userSubmoduleResult;
                  }
               }
               default:
                  if (subCmdMatch.match) args[1] = subCmdMatch.match;
            }
            break;
         }
         case 'tag': {
            const subCommands = ['move', 'mv'];
            const subCmdMatch = progressiveMatch(args[1] || '', subCommands, true);
            if (subCmdMatch.match) args[1] = subCmdMatch.match;

            if (args[1] === 'mv') {
               args[1] = 'move';
            }

            if (args[1] === 'move') {
               return await cmd.tag.move(ctx);
            }
            break;
         }
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
         case 'diff': {
            const { error } = await expandRelativeRef(args, ctx.git$);
            if (error) return 1;

            const config = await getConfig();
            if (
               noEnhancedOutput &&
               config.get<boolean>('enhancedOutput') &&
               canUseDiffViewer() &&
               !args.includes('--stat') &&
               !args.includes('-h') &&
               !args.includes('--help') &&
               !args.includes('--numstat') &&
               !args.includes('--name-only') &&
               !args.includes('--name-status')
            ) {
               const diffArgs = args.slice(1);
               const asJson = diffArgs.popOption('--json');

               try {
                  const result = await $`${ctx.git$} -c color.ui=never diff ${diffArgs}`;
                  if (result.stdout) {
                     if (asJson) {
                        const parsed = parseDiffOutput(result.stdout);
                        quickPrint(JSON.stringify(parsed, null, 2));
                        return 0;
                     }
                     const usesCachedDiff =
                        diffArgs.hasOption('--cached') || diffArgs.hasOption('--staged');
                     const canUseFullFileHighlight = !diffArgs.hasOption('--no-index');

                     await viewDiff(
                        result.stdout,
                        canUseFullFileHighlight
                           ? {
                              git$: ctx.git$,
                              highlighting: {
                                 oldRevision: 'HEAD',
                                 newRevision: usesCachedDiff ? INDEX_REVISION : WORKING_TREE_REVISION,
                              },
                           }
                           : undefined
                     );
                     return 0;
                  }
               } catch (e) {
                  Logger.info(
                     'Failed to get or parse diff output for enhanced diff-view, ignoring: ' +
                     Err.from(e)
                  );
               }
            }
            break;
         }
         case 'show': {
            const { error } = await expandRelativeRef(args, ctx.git$);
            if (error) return 1;
            const { error: showPathRefError } = await expandShowRevisionPathRefs(args, ctx.git$);
            if (showPathRefError) return 1;

            const config = await getConfig();
            if (
               noEnhancedOutput &&
               config.get<boolean>('enhancedOutput') &&
               canUseDiffViewer() &&
               !args.includes('--stat') &&
               !args.includes('-h') &&
               !args.includes('--help') &&
               !args.includes('--numstat') &&
               !args.includes('--name-only') &&
               !args.includes('--name-status') &&
               !args.hasOption('--format')
            ) {
               const showArgs = args.slice(1);
               const asJson = showArgs.popOption('--json');

               try {
                  const result = await $`${ctx.git$} -c color.ui=never show ${showArgs}`;
                  if (
                     result.stdout &&
                     (isGitDiffOutput(result.stdout) || isGitShowCommitOutput(result.stdout))
                  ) {
                     if (asJson) {
                        const parsed = parseDiffOutput(result.stdout);
                        quickPrint(JSON.stringify(parsed, null, 2));
                        return 0;
                     }

                     await viewInteractiveShow(ctx, showArgs, result.stdout);
                     return 0;
                  }
                  const blobPlan = buildShowBlobNavigationPlan(showArgs);
                  if (blobPlan && !asJson) {
                     await viewInteractiveShowBlob(ctx, showArgs, blobPlan, result.stdout);
                     return 0;
                  }
               } catch (e) {
                  Logger.info(
                     'Failed to get show output for enhanced diff-view, ignoring: ' + Err.from(e)
                  );
               }
            }
            break;
         }
         case 'ps': // alias for 'push'
            args[0] = 'push';
         case 'push': {
            // Check for auto-lint
            if (!args.popOption('--no-lint')) {
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
                           SGR.yellow +
                           'Lint failed, but proceeding with push (warning mode).' +
                           SGR.reset
                        );
                     }
                  }
               }
            }

            // Replace -fl with --force-with-lease
            args.spliceOption('-fl', ['--force-with-lease'], 1);
            break;
         }
         case 'ad': // alias for 'add'
            args[0] = 'add';
            break;
         case 'rv': // alias for 'revert'
            args[0] = 'revert';
            break;
         case 'rb': // alias for 'rebase'
            args[0] = 'rebase';
            break;
         case 'reset': {
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
            }

            const { error } = await expandRelativeRef(args, ctx.git$);
            if (error) return 1;
            break;
         }
         case 'log':
         case 'lg': // alias for 'log'
            if (args[0] === 'lg' && args.length === 1) {
               args.push('--oneline', '--graph', '--decorate', '--all');
            } else if (args.popOption('export')) {
               // Handle 'lg export' case
               let dateFmt: string = '--date=format:"%Y-%m-%d %H:%M"';
               const hasAuthor = args.hasOption('--author', 1);

               if (!hasAuthor) {
                  const git$ = Array.isArray(ctx.git$) ? ctx.git$[0] : ctx.git$;
                  args.push('--author=' + (await getGitConfigCached(git$, 'user.email')));
               }

               const relativeIdx = args.indexOf('--relative');
               if (relativeIdx >= 0) {
                  args.splice(relativeIdx, 1);
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
                  if (subCommands.includes(args[i]) || args[i] === '-h' || args[i] === '--help') {
                     hasSubCmd = true;
                     break;
                  }
               }

               if (!hasSubCmd) {
                  const git$ = Array.isArray(ctx.git$) ? ctx.git$[0] : ctx.git$;
                  const suportsPush =
                     compareVersions(await getGitVersionCached(git$), '2.15.0') >= 0;
                  const defaultSubCmd = suportsPush ? 'push' : 'save';
                  args.splice(1, 0, defaultSubCmd); // Default to 'push' or 'save' if no sub-command
               }
            }

            if (args[1] === 'drop') {
               const git$ = Array.isArray(ctx.git$) ? ctx.git$[0] : ctx.git$;
               return await cmd.stash.drop(git$, args);
            }
            break;
         }
         case 'graph':
            return cmd.graph(ctx);
         case 'stats':
            return cmd.stats(ctx);
         case 'switch':
            expandRelativeRef(args, ctx.git$, 1);
            break;
         case 'clear':
            return cmd.clear(ctx);
         case 'cache':
            return cmd.cache(ctx);
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
         case 'macro':
            return cmd.macro(ctx);
         case 'reword':
            return cmd.reword(ctx);
         case 'snap':
            return cmd.snap(ctx);
         default:
            if (candidates && candidates.length > 1) {
               Logger.warn(
                  `Ambiguous command '${originalArgs[0]}'. Did you mean one of: ${candidates.join(', ')}?`
               );
               break AliasNCustomCmd;
            }
      }
   }

   if (state.inMacro || originalArgs.some((a, i) => args[i] !== a)) {
      const colorVec = hslToRgbVec(((args.length % 6) + 1) / 8.6, 0.64, 0.5);
      quickPrint(
         SGR.dim +
         ncc(rgbVec2decimal(colorVec), 'fg') +
         `$ ${SGR.white + SGR.bright}git ${escapeCmdArgs(args).join(' ')}` +
         SGR.reset
      );
   }

   return execGit(ctx.git$, args, redirectTo, redirectMode);
}
