
import { execa } from 'execa';
import { Err, ncc, yuString } from '../lib/esm/Tools';
import cmd from './commands'
import { COMMON_GIT_CMDS } from './consts';
import { $, $inherit, whichExec } from './utils/shell';
import { arrDelete, escapeCmdArgs, progressiveMatch, quickPrint } from './utils/utilities';
import { ArgsSet } from './utils/arguments';
import { GdxContext } from './common/types';

const _args = process.argv.slice(2);

async function main(): Promise<number> {
   const git$ = await whichExec('git');
   if (!git$) {
      throw new Err(
         'Git is not installed or not found in PATH.',
         'GIT_NOT_FOUND'
      );
   }

   const ctx: GdxContext = {
      args: new ArgsSet(_args),
      git$,
   }
   const args = ctx.args;

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

   AliasNCustomCmd:
   if (args[0]) {
      const { match, candidates } = progressiveMatch(args[0], COMMON_GIT_CMDS);

      if (match)
         args[0] = match;

      switch (args[0]) {
         case 's': // alias for 'status'
            args[0] = 'status';
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
         case 'ps': // alias for 'push'
            args[0] = 'push';
         case 'push':
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
         case 'lg': // alias for 'log'
            args[0] = 'log';

            if (args.length === 1) {
               args.push('--oneline', '--graph', '--decorate', '--all');
            }
            else if (args.includes('export')) {
               arrDelete('export', args);

               // Handle 'lg export' case
               const rest = args.slice(1);
               let dateFmt: string = '--date=format:"%Y-%m-%d %H:%M"';
               const hasAuthor = rest.some(arg =>
                  arg === '--author' || arg.startsWith('--author=')
               );

               if (!hasAuthor) {
                  args.push('--author=' + (await $`${git$} config user.email`).stdout.trim());
               }

               if (rest.includes('--relative')) {
                  dateFmt = '--date=format:"%Y-%m-%d %H:%M" (%ar)';
                  arrDelete('--relative', rest);
               }

               const additionalArgs = [
                  '--all',
                  '--pretty=format:## Commit %h on [%p] - %ad%d\n%s\n\n%b\n---\n',
                  dateFmt,
               ].filter(arg => !rest.some(a => a === arg || a.startsWith(arg.split('=')[0])));
               args.push(...additionalArgs);
               redirectTo = 'gitlog_export.md';
               redirectMode = '>';
            }
            break;
         case 'stash': {
            const subCmdMatch = progressiveMatch(args[1] || '', [
               'save', 'apply', 'pop', 'list', 'drop', 'clear'
            ]);

            if (subCmdMatch.match)
               args[1] = subCmdMatch.match;

            if (
               args[1] === 'drop' &&
               args.length >= 3 &&
               /\d+\.\.\d+$/.test(args[2])
            ) {
               return await cmd.stash.dropRange(git$, args);
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
         default:
            if (candidates && candidates.length > 1)
               break AliasNCustomCmd;
      }
   }

   if (args[0] !== originalCmd) {
      quickPrint(
         ncc('Cyan') + `Command auto expanded to: git ${escapeCmdArgs(args).join(' ')}` + ncc()
      );
   }

   let exitCode: number | undefined = 0;
   try {
      if (redirectTo) {
         const { exitCode: eCode } = await execa({
            stdout: {
               file: redirectTo,
               append: redirectMode === '>>'
            },
            stderr: 'inherit'
         })`${git$} ${args}`;
         exitCode = eCode;
      }
      else {
         const { exitCode: eCode } = await $inherit`${git$} ${args}`;
         exitCode = eCode;
      }
   }
   catch (_err) {
      const err = Err.from(_err);
      if (err.name === 'ExecaError' && err.message.startsWith('Command failed'))
         return exitCode || 1; // git command failed, return exit code

      console.error('Command failed.\n' + yuString(err, { color: true }));
      return 1;
   };

   return exitCode ?? 0;
}

(async () => {
   try {
      const exitCode = await main();
      process.exit(exitCode);
   }
   catch (err) {
      console.error(yuString(err, { color: true }));
      process.exit(1);
   }
})();
