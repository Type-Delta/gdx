import { hyperlink, ncc, strJustify, strWrap } from '@lib/Tools';

import { GDX_VPALETTE, EXECUTABLE_NAME, REPO_README_URL, VERSION } from '@/consts';
import { quickPrint } from '@/utils/utilities';
import { _2PointGradient } from '@/modules/graphics';
import global from '@/global';

import { help as stashHelp } from './stash';
import { help as statsHelp } from './stats';
import { help as graphHelp } from './graph';
import { help as nocapHelp } from './nocap';
import { help as parallelHelp } from './parallel';
import { help as gdxConfigHelp } from './gdx-config';
import { help as commitHelp } from './commit';
import { help as clearHelp } from './clear';
import { help as cacheHelp } from './cache';
import { help as lintHelp } from './lint';
import { help as statusHelp } from './status';
import { help as doctorHelp } from './doctor';
import { help as submoduleHelp } from './submodule';
import { help as rewordHelp } from './reword';
import { CommandHelpObj, CommandStructure } from '@/common/types';

export default function help(name?: string): number {
   const cyan = ncc('Cyan');
   const yellow = ncc('Yellow');
   const bright = ncc('Bright');
   const dim = ncc('Dim');
   const reset = ncc('Reset');

   const HELP_MAP: Record<string, CommandHelpObj> = {
      cache: cacheHelp,
      stash: stashHelp,
      stats: statsHelp,
      graph: graphHelp,
      nocap: nocapHelp,
      parallel: parallelHelp,
      'gdx-config': gdxConfigHelp,
      commit: commitHelp,
      clear: clearHelp,
      lint: lintHelp,
      status: statusHelp,
      doctor: doctorHelp,
      submodule: submoduleHelp,
      reword: rewordHelp,
   };

   if (!name) {
      // LINK: dn2jka text literal in spec
      quickPrint(
         strWrap(
            `
──────────────────────────────
${bright + _2PointGradient('GDX (Git Developer eXperience)', GDX_VPALETTE.OceanDeepBlue, GDX_VPALETTE.OceanGreen, 0.32, 1) + reset}
Version: ${cyan + VERSION + reset}
──────────────────────────────

Git, but with better DX. The raw power of Git,
aligned with human workflows.

${bright + _2PointGradient('DESCRIPTION', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
${EXECUTABLE_NAME} (wrapper) — shorthand-friendly wrapper for git (executable) with common shortcuts,
stash-range support, and convenience expansions.
It forwards unrecognized commands/args to git (executable) unchanged.

${bright + _2PointGradient('SYNOPSIS', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
${EXECUTABLE_NAME} <command> [<args>]
Examples:
   ${cyan}${EXECUTABLE_NAME} st           ${reset + dim}# shorthand for ${EXECUTABLE_NAME} stash${reset}
   ${cyan}${EXECUTABLE_NAME} lg           ${reset + dim}# shorthand for ${EXECUTABLE_NAME} log --oneline --graph --all --decorate${reset}
   ${cyan}${EXECUTABLE_NAME} stash d 2..6 ${reset + dim}# drop stashes 2 through 6 (safe: drops high->low)${reset}
   ${cyan}${EXECUTABLE_NAME} clear        ${reset + dim}# backup changes to a temp patch file and reset working directory (use \`${cyan}${EXECUTABLE_NAME} clear pardon${ncc('White')}\` to restore)${reset}
   ${cyan}${EXECUTABLE_NAME} cmi auto     ${reset + dim}# generate commit message based on staged changes using LLM${reset}

${bright + _2PointGradient('KEY FEATURES', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
- Many short aliases for common commands (commit, branch, checkout, etc.).
- Smart expansions:
   - log: ${cyan}${EXECUTABLE_NAME} lg ${reset + dim}-> ${reset + cyan}${EXECUTABLE_NAME} log --oneline --graph --all --decorate${reset}
   - log export: ${cyan}${EXECUTABLE_NAME} lg export [extra args] ${reset + dim}creates a nicely formatted
      export (adds --author if missing).${reset}
   - pull: ${cyan}${EXECUTABLE_NAME} pl -au ${reset + dim}-> expands -au to --allow-unrelated-histories.${reset}
   - push: ${cyan}${EXECUTABLE_NAME} ps -fl ${reset + dim}-> expands -fl to --force-with-lease.${reset}
   - reset: ${cyan}${EXECUTABLE_NAME} res -h ${reset + dim}-> ${reset + cyan}${EXECUTABLE_NAME} reset --hard${reset + dim}; ${reset + cyan}${EXECUTABLE_NAME} res ~3 ${reset + dim}-> ${reset + cyan}${EXECUTABLE_NAME} reset HEAD~3${reset}
     ${dim}(also supports ${cyan}origin~N${reset + dim} for upstream-relative resets)${reset}
- Clear convenience:
      - ${cyan}${EXECUTABLE_NAME} clear ${reset + dim}->${reset} creates a timestamped patch backup
        in the system temp folder, then resets the working directory
        (${cyan}${EXECUTABLE_NAME} reset --hard ${reset + dim}+ ${reset + cyan}${EXECUTABLE_NAME} clean -fd${reset}).
      - Use \`${cyan}${EXECUTABLE_NAME} clear pardon${reset}\` to apply the latest backup patch
        and restore changes. Add \`${cyan}-f${reset}\`/\`${cyan}--force${reset}\` to bypass dirty-working-directory prompts.
- Stash convenience:
      - Short forms: ${cyan}${EXECUTABLE_NAME} sta / ${EXECUTABLE_NAME} st${reset} for stash; ${cyan}${EXECUTABLE_NAME} sta l${reset} -> stash list.
      - ${cyan}${EXECUTABLE_NAME} stash d 2..6${reset} — drops stash@{6}..stash@{2} (drops high→low to
        avoid index shift).
      - Supports apply, pop, drop, list, show, clear via short forms.
- Quick worktrees:
   - ${cyan}${EXECUTABLE_NAME} parallel fork/remove/join/switch/open/list${reset} for temp-backed worktree workflows.

${bright + _2PointGradient('SHORTHAND LIST (common)', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
${cyan}ad                 ${reset + dim}-> ${reset}add
${cyan}bra, br            ${reset + dim}-> ${reset}branch
${cyan}clear              ${reset + dim}-> ${reset}clear (backup changes and reset working directory; use \`${cyan}pardon${reset}\` to restore)
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

${bright + _2PointGradient('CUSTOM COMMAND LIST', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
${formatShortCmdList(HELP_MAP, { cyan, reset })}

${bright + _2PointGradient('OPTIONS', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
${cyan}--init <shell>         ${reset}Output shell initialization script for given shell.
${cyan}--bypass               ${reset}Bypass gdx and execute git directly with the provided arguments.
${cyan}--no-enhance           ${reset}Bypass gdx enhanced Git's output.
${cyan}--loglevel <level>     ${reset}Set log level (error, warning, info, debug).
${cyan}--ghelp,               ${reset}Show GDX help message. ${dim}(use \`${cyan}ghelp <command>${reset}\`
${cyan}  --gdx-help, -gh      ${reset + dim}for command-specific help)${reset}
${cyan}-r, --recursive        ${yellow}[For '${EXECUTABLE_NAME} status']${reset} Recursively show git status of submodules.
${cyan}-au                    ${yellow}[For '${EXECUTABLE_NAME} pull']${reset} Shorthand for ${cyan}--allow-unrelated-histories${reset}.
${cyan}--on-lint              ${yellow}[For '${EXECUTABLE_NAME} push']${reset} Skip linting for this push${reset}.
${cyan}-fl                    ${yellow}[For '${EXECUTABLE_NAME} push']${reset} Shorthand for ${cyan}--force-with-lease${reset}.
${cyan}-h                     ${yellow}[For '${EXECUTABLE_NAME} reset']${reset} Shorthand for ${cyan}--hard${reset}.
${cyan}-s                     ${yellow}[For '${EXECUTABLE_NAME} reset']${reset} Shorthand for ${cyan}--soft${reset}.

${bright + _2PointGradient('RELATIVE REF EXPANSION', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
Expansions are triggered by specific shorthand patterns in the arguments. When detected, they are expanded to their full form before being passed to git.

Syntax:
  [origin|head]~[<number>] (e.g. ${cyan}~3${reset}, ${cyan}origin~2${reset})
  - origin~N expansions resolve relative to the current branch's upstream (e.g. origin~2 -> upstream~2).
  - ~N or head~N expansions resolve relative to HEAD (e.g. ~3 -> HEAD~3).
  - [head] and <number> can be omitted, they will default to HEAD and 0 respectively (e.g. ${cyan}origin~${reset} -> upstream, ${cyan}~${reset} -> HEAD).

Examples:
- ${cyan}${EXECUTABLE_NAME} reset ~3${reset} expands to ${cyan}${EXECUTABLE_NAME} reset HEAD~3${reset}.
- ${cyan}${EXECUTABLE_NAME} reset -h${reset} expands to ${cyan}${EXECUTABLE_NAME} reset --hard${reset}.
- ${cyan}${EXECUTABLE_NAME} show origin ~2${reset} expands to ${cyan}${EXECUTABLE_NAME} show <upstream>~2${reset}.
- ${cyan}${EXECUTABLE_NAME} diff origin ~2${reset} expands to ${cyan}${EXECUTABLE_NAME} diff <upstream>~2${reset}.

${bright + _2PointGradient('NOTES & SAFETY', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
- Help message for individual custom commands is available via
   ${cyan}${EXECUTABLE_NAME} ghelp <command>${reset} (e.g. ${cyan}${EXECUTABLE_NAME} ghelp stash${reset}).
- Range notation must be numeric and in the form start..end (e.g. 2..6).
- The wrapper prints an auto-expansion message when it expands a shorthand.
- If you rely on advanced argument parsing or unusual ${EXECUTABLE_NAME} flags, you can
   bypass expansions by using the full command name
   so they are not recognized as shorthand triggers.
- For more infomation, see ${hyperlink('README.md', REPO_README_URL)}.`,
            Math.min(100, global.terminalWidth - 4),
            {
               firstIndent: '  ',
               mode: 'softboundary',
               indent: '  ',
            }
         )
      );
      return 0;
   }

   const cmdName = name.replace(/^\/+/, '');
   if (cmdName === 'help') {
      // Show the full built-in help when requesting help for 'help'
      return help();
   }

   const h = HELP_MAP[cmdName];
   let message = '';
   if (h && h.long) message = h.long();
   if (message && h.usage)
      message +=
         '\n  ' +
         bright +
         _2PointGradient('USAGE', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) +
         reset +
         h.usage();

   if (message) {
      quickPrint(message);
      return 0;
   }

   // LINK: dnn2j2k text literal in spec
   quickPrint(`No help found for '${cmdName}'.`);
   return 1;
}

function formatShortCmdList(
   helpObj: Record<string, CommandHelpObj>,
   colors: { cyan: string; reset: string }
): string {
   const res = [];
   for (const [cmd, h] of Object.entries(helpObj)) {
      res.push(
         `${colors.cyan}${strJustify(cmd, 19, {
            overflow: 'visible',
            align: 'left',
            redundancyLv: 0,
         })}${colors.reset}${strWrap(h.short, 60, {
            indent: 19,
            firstIndent: 0,
            redundancyLv: 0,
            mode: 'strict',
         })}`
      );
   }
   return res.join('\n');
}

export const structure = {
   $root: [
      'cache',
      'clear',
      'commit',
      'doctor',
      'graph',
      'gdx-config',
      'lint',
      'nocap',
      'parallel',
      'stash',
      'stats',
      'status',
   ],
} as const satisfies CommandStructure;
