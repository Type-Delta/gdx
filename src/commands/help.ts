import { hyperLink, ncc, strWrap } from '@lib/Tools';

import { COLOR, EXECUTABLE_NAME, REPO_README_URL, VERSION } from '@/consts';
import { quickPrint } from '@/utils/utilities';
import { _2PointGradient } from '@/modules/graphics';

import { help as stashHelp } from './stash';
import { help as statsHelp } from './stats';
import { help as graphHelp } from './graph';
import { help as nocapHelp } from './nocap';
import { help as parallelHelp } from './parallel';
import { help as gdxConfigHelp } from './gdx-config';
import { help as commitHelp } from './commit';
import { help as clearHelp } from './clear';
import { help as lintHelp } from './lint';
import { CommandHelpObj } from '@/common/types';

export default function help(name?: string): number {
   const cyan = ncc('Cyan');
   const bright = ncc('Bright');
   const dim = ncc('Dim');
   const reset = ncc('Reset');

   if (!name) {
      // LINK: dn2jka text literal in spec
      quickPrint(
         strWrap(
            `
──────────────────────────────
${bright + _2PointGradient('GDX (Git Developer eXperience)', COLOR.OceanDeepBlue, COLOR.OceanGreen, 0.32, 1)}
Version: ${cyan + VERSION + reset}
──────────────────────────────

Git, but with better DX. The raw power of Git,
aligned with human workflows.

${bright + _2PointGradient('DESCRIPTION', COLOR.Zinc400, COLOR.Zinc100, 0.2)}
${EXECUTABLE_NAME} (wrapper) — shorthand-friendly wrapper for git (executable) with common shortcuts,
stash-range support, and convenience expansions.
It forwards unrecognized commands/args to git (executable) unchanged.

${bright + _2PointGradient('SYNOPSIS', COLOR.Zinc400, COLOR.Zinc100, 0.2)}
${EXECUTABLE_NAME} <command> [<args>]
Examples:
   ${cyan}${EXECUTABLE_NAME} st           ${reset + dim}# shorthand for ${EXECUTABLE_NAME} stash${reset}
   ${cyan}${EXECUTABLE_NAME} lg           ${reset + dim}# shorthand for ${EXECUTABLE_NAME} log --oneline --graph --all --decorate${reset}
   ${cyan}${EXECUTABLE_NAME} stash d 2..6 ${reset + dim}# drop stashes 2 through 6 (safe: drops high->low)${reset}
   ${cyan}${EXECUTABLE_NAME} clear        ${reset + dim}# backup changes to a temp patch file and reset working directory (use \`${EXECUTABLE_NAME} clear pardon\` to restore)${reset}
   ${cyan}${EXECUTABLE_NAME} cmi auto     ${reset + dim}# generate commit message based on staged changes using LLM${reset}

${bright + _2PointGradient('KEY FEATURES', COLOR.Zinc400, COLOR.Zinc100, 0.2)}
- Many short aliases for common commands (commit, branch, checkout, etc.).
- Smart expansions:
   - log: ${cyan}${EXECUTABLE_NAME} lg ${reset + dim}-> ${reset + cyan}${EXECUTABLE_NAME} log --oneline --graph --all --decorate${reset}
   - log export: ${cyan}${EXECUTABLE_NAME} lg export [extra args] ${reset + dim}creates a nicely formatted
      export (adds --author if missing).${reset}
   - pull: ${cyan}${EXECUTABLE_NAME} pl -au ${reset + dim}-> expands -au to --allow-unrelated-histories.${reset}
   - push: ${cyan}${EXECUTABLE_NAME} ps -fl ${reset + dim}-> expands -fl to --force-with-lease.${reset}
   - reset: ${cyan}${EXECUTABLE_NAME} res -h ${reset + dim}-> ${reset + cyan}${EXECUTABLE_NAME} reset --hard${reset + dim}; ${reset + cyan}${EXECUTABLE_NAME} res ~3 ${reset + dim}-> ${reset + cyan}${EXECUTABLE_NAME} reset HEAD~3${reset}
- Clear convenience:
      - ${cyan}${EXECUTABLE_NAME} clear ${reset + dim}->${reset} creates a timestamped patch backup
        in the system temp folder, then resets the working directory
        (${cyan}${EXECUTABLE_NAME} reset --hard ${reset + dim}+ ${reset + cyan}${EXECUTABLE_NAME} clean -fd${reset}).
      - Use \`${reset + cyan}${EXECUTABLE_NAME} clear pardon${reset}\` to apply the latest backup patch
        and restore changes. Add \`-f\`/\`--force\` to bypass dirty-working-directory prompts.
- Stash convenience:
      - Short forms: ${cyan}${EXECUTABLE_NAME} sta / ${EXECUTABLE_NAME} st${reset} for stash; ${cyan}${EXECUTABLE_NAME} sta l${reset} -> stash list.
      - ${cyan}${EXECUTABLE_NAME} stash d 2..6${reset} — drops stash@{6}..stash@{2} (drops high→low to
        avoid index shift).
      - Supports apply, pop, drop, list, show, clear via short forms.
- Quick worktrees:
   - ${cyan}${EXECUTABLE_NAME} parallel fork/remove/join/switch/open/list${reset} for temp-backed worktree workflows.

${bright + _2PointGradient('SHORTHAND LIST (common)', COLOR.Zinc400, COLOR.Zinc100, 0.2)}
${cyan}ad                 ${reset + dim}-> ${reset}add
${cyan}bra, br            ${reset + dim}-> ${reset}branch
${cyan}clear              ${reset + dim}-> ${reset}clear (backup changes and reset working directory; use \`pardon\` to restore)
${cyan}cl, clo            ${reset + dim}-> ${reset}clone
${cyan}com, comm, cmi     ${reset + dim}-> ${reset}commit
${cyan}che, checko, co    ${reset + dim}-> ${reset}checkout
${cyan}dif                ${reset + dim}-> ${reset}diff
${cyan}lg, lo             ${reset + dim}-> ${reset}log (auto-expanded)
${cyan}pl, pul            ${reset + dim}-> ${reset}pull
${cyan}ps, pus            ${reset + dim}-> ${reset}push
${cyan}rb, rebas          ${reset + dim}-> ${reset}rebase
${cyan}res, rese          ${reset + dim}-> ${reset}reset
${cyan}rv, rever          ${reset + dim}-> ${reset}revert
${cyan}mg, merg           ${reset + dim}-> ${reset}merge
${cyan}in, ini            ${reset + dim}-> ${reset}init
${cyan}sta, st            ${reset + dim}-> ${reset}stash
${cyan}s, stat            ${reset + dim}-> ${reset}status
${cyan}swit, sw           ${reset + dim}-> ${reset}switch

${bright + _2PointGradient('CUSTOM COMMAND LIST', COLOR.Zinc400, COLOR.Zinc100, 0.2)}
${cyan}clear              ${reset}backup changes to a temp patch file and reset working directory
${cyan}stats              ${reset}show user contribution statistics
${cyan}graph              ${reset}show contribution graph
${cyan}nocap              ${reset}generate a funny Gen-Z style comment for the latest commit by your commit author
${cyan}parallel           ${reset}manage forked worktrees (fork/remove/join/switch/list)
${cyan}lint               ${reset}lint outgoing commits for format, spelling, sensitive data, and more

${bright + _2PointGradient('STASH USAGE EXAMPLES', COLOR.Zinc400, COLOR.Zinc100, 0.2)}
   ${cyan}stash l         ${reset}Show stash list (alias for ${EXECUTABLE_NAME} stash list).
   ${cyan}stash d 3       ${reset}Drop stash@{3}.
   ${cyan}stash d 2..5    ${reset}Drop stash@{5}, stash@{4}, stash@{3}, stash@{2} (safe ordering).
   ${cyan}stash p 1       ${reset}Pop stash@{1}.
   ${cyan}stash c         ${reset}Clear all stashes (maps to ${EXECUTABLE_NAME} stash clear — destructive).

${bright + _2PointGradient('LOG EXPORT EXAMPLE', COLOR.Zinc400, COLOR.Zinc100, 0.2)}
${cyan}${EXECUTABLE_NAME} lg export --author="me@example.com"${reset}
   Generate a formatted log export file (wrapper will add default
   --author if missing and format the output for export).

${bright + _2PointGradient('NOTES & SAFETY', COLOR.Zinc400, COLOR.Zinc100, 0.2)}
- Help message for individual custom commands is available via
   ${cyan}${EXECUTABLE_NAME} ghelp <command>${reset} (e.g. ${cyan}${EXECUTABLE_NAME} ghelp stash${reset}).
- Range notation must be numeric and in the form start..end (e.g. 2..6).
- The wrapper prints an auto-expansion message when it expands a shorthand.
- If you rely on advanced argument parsing or unusual ${EXECUTABLE_NAME} flags, you can
   bypass expansions by using the full command name
   so they are not recognized as shorthand triggers.
- For more infomation, see ${hyperLink('README.md', REPO_README_URL)}.`,
            100,
            {
               firstIndent: '  ',
               mode: 'softboundery',
               indent: '  ',
            }
         )
      );
      return 0;
   }

   const cmdName = name.replace(/^\/+/, '');
   const HELP_MAP: Record<string, CommandHelpObj> = {
      stash: stashHelp,
      stats: statsHelp,
      graph: graphHelp,
      nocap: nocapHelp,
      parallel: parallelHelp,
      'gdx-config': gdxConfigHelp,
      gdx_config: gdxConfigHelp,
      commit: commitHelp,
      clear: clearHelp,
      lint: lintHelp,
   };

   if (cmdName === 'help') {
      // Show the full built-in help when requesting help for 'help'
      return help();
   }

   const h = HELP_MAP[cmdName];
   let message = '';
   if (h && h.long) message = h.long();
   if (message && h.usage)
      message +=
         '  ' +
         ncc('Bright') +
         _2PointGradient('USAGE', COLOR.Zinc400, COLOR.Zinc100, 0.2) +
         h.usage();

   if (message) {
      quickPrint(message);
      return 0;
   }

   // LINK: dnn2j2k text literal in spec
   quickPrint(`No help found for '${cmdName}'.`);
   return 1;
}
