import { hyperlink, strJustify, strWrap } from '@lib/Tools';

import { GDX_VPALETTE, EXECUTABLE_NAME, REPO_README_URL, VERSION, SGR } from '@/consts';
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
import { help as macroHelp } from './macro';
import { help as tagHelp } from './tag';
import { help as snapHelp } from './snap';
import { help as ghHelp } from './gh';
import { CommandHelpObj, CommandStructure } from '@/common/types';

const EXTENSION_HELP_MAP: Record<string, CommandHelpObj> = {
   tag: tagHelp,
   stash: stashHelp,
   commit: commitHelp,
   submodule: submoduleHelp,
   status: statusHelp,
};
const COMMAND_HELP_MAP: Record<string, CommandHelpObj> = {
   cache: cacheHelp,
   stats: statsHelp,
   graph: graphHelp,
   nocap: nocapHelp,
   parallel: parallelHelp,
   'gdx-config': gdxConfigHelp,
   clear: clearHelp,
   lint: lintHelp,
   doctor: doctorHelp,
   reword: rewordHelp,
   macro: macroHelp,
   snap: snapHelp,
   gh: ghHelp,
};
const FIRST_COL_WIDTH = 23;

export default function help(name?: string): number {
   if (!name) {
      // LINK: dn2jka text literal in spec
      quickPrint(
         strWrap(
            `
──────────────────────────────
${SGR.bright + _2PointGradient('GDX (Git Developer eXperience)', GDX_VPALETTE.OceanDeepBlue, GDX_VPALETTE.OceanGreen, 0.32, 1) + SGR.reset}
Version: ${SGR.cyan + VERSION + SGR.reset}
──────────────────────────────

Git, but with better DX. The raw power of Git,
aligned with human workflows.

${SGR.bright + _2PointGradient('DESCRIPTION', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
${EXECUTABLE_NAME} (wrapper) — shorthand-friendly wrapper for git (executable) with common shortcuts,
stash-range support, and convenience expansions.
It forwards unrecognized commands/args to git (executable) unchanged.

${SGR.bright + _2PointGradient('SYNOPSIS', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
${EXECUTABLE_NAME} <command> [<args>]
Examples:
   ${SGR.cyan}${EXECUTABLE_NAME} st           ${SGR.reset + SGR.dim}# shorthand for ${EXECUTABLE_NAME} stash${SGR.reset}
   ${SGR.cyan}${EXECUTABLE_NAME} lg           ${SGR.reset + SGR.dim}# shorthand for ${EXECUTABLE_NAME} log --oneline --graph --all --decorate${SGR.reset}
   ${SGR.cyan}${EXECUTABLE_NAME} stash d 2..6 ${SGR.reset + SGR.dim}# drop stashes 2 through 6 (safe: drops high->low)${SGR.reset}
   ${SGR.cyan}${EXECUTABLE_NAME} clear        ${SGR.reset + SGR.dim}# backup changes to a temp patch file and reset working directory
                    # (use \`${SGR.cyan}${EXECUTABLE_NAME} clear pardon${SGR.white}\` to restore)${SGR.reset}
   ${SGR.cyan}${EXECUTABLE_NAME} cmi auto     ${SGR.reset + SGR.dim}# generate commit message based on staged changes using LLM${SGR.reset}

${SGR.bright + _2PointGradient('KEY FEATURES', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
- Many short aliases for common commands (commit, branch, checkout, etc.).
- Smart expansions:
   - log: ${SGR.cyan}${EXECUTABLE_NAME} lg ${SGR.reset + SGR.dim}-> ${SGR.reset + SGR.cyan}${EXECUTABLE_NAME} log --oneline --graph --all --decorate${SGR.reset}
   - log export: ${SGR.cyan}${EXECUTABLE_NAME} lg export [extra args] ${SGR.reset + SGR.dim}creates a nicely formatted
      export (adds --author if missing).${SGR.reset}
   - pull: ${SGR.cyan}${EXECUTABLE_NAME} pl -au ${SGR.reset + SGR.dim}-> expands -au to --allow-unrelated-histories.${SGR.reset}
   - push: ${SGR.cyan}${EXECUTABLE_NAME} ps -fl ${SGR.reset + SGR.dim}-> expands -fl to --force-with-lease.${SGR.reset}
   - reset: ${SGR.cyan}${EXECUTABLE_NAME} res -h ${SGR.reset + SGR.dim}-> ${SGR.reset + SGR.cyan}${EXECUTABLE_NAME} reset --hard${SGR.reset + SGR.dim}; ${SGR.reset + SGR.cyan}${EXECUTABLE_NAME} res ~3 ${SGR.reset + SGR.dim}-> ${SGR.reset + SGR.cyan}${EXECUTABLE_NAME} reset HEAD~3${SGR.reset}
     ${SGR.dim}(also supports ${SGR.cyan}origin~N${SGR.reset + SGR.dim} for upstream-relative resets)${SGR.reset}
- Clear convenience:
      - ${SGR.cyan}${EXECUTABLE_NAME} clear ${SGR.reset + SGR.dim}->${SGR.reset} creates a timestamped patch backup
        in the system temp folder, then resets the working directory
        (${SGR.cyan}${EXECUTABLE_NAME} reset --hard ${SGR.reset + SGR.dim}+ ${SGR.reset + SGR.cyan}${EXECUTABLE_NAME} clean -fd${SGR.reset}).
      - Use \`${SGR.cyan}${EXECUTABLE_NAME} clear pardon${SGR.reset}\` to apply the latest backup patch
        and restore changes. Add \`${SGR.cyan}-f${SGR.reset}\`/\`${SGR.cyan}--force${SGR.reset}\` to bypass dirty-working-directory prompts.
- Stash convenience:
      - Short forms: ${SGR.cyan}${EXECUTABLE_NAME} sta / ${EXECUTABLE_NAME} st${SGR.reset} for stash; ${SGR.cyan}${EXECUTABLE_NAME} sta l${SGR.reset} -> stash list.
      - ${SGR.cyan}${EXECUTABLE_NAME} stash d 2..6${SGR.reset} — drops stash@{6}..stash@{2} (drops high→low to
        avoid index shift).
      - Supports apply, pop, drop, list, show, clear via short forms.
- Quick worktrees:
   - ${SGR.cyan}${EXECUTABLE_NAME} parallel fork/remove/join/switch/open/list${SGR.reset} for temp-backed worktree workflows.

${SGR.bright + _2PointGradient('SHORTHAND LIST (common)', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
${SGR.cyan}ad                  ${SGR.reset + SGR.dim}-> ${SGR.reset}add
${SGR.cyan}bra, br             ${SGR.reset + SGR.dim}-> ${SGR.reset}branch
${SGR.cyan}clear               ${SGR.reset + SGR.dim}-> ${SGR.reset}clear (backup changes and reset working directory; use \`${SGR.cyan}pardon${SGR.reset}\` to restore)
${SGR.cyan}cl, clo             ${SGR.reset + SGR.dim}-> ${SGR.reset}clone
${SGR.cyan}com, comm, cmi      ${SGR.reset + SGR.dim}-> ${SGR.reset}commit
${SGR.cyan}che, checko, co     ${SGR.reset + SGR.dim}-> ${SGR.reset}checkout
${SGR.cyan}dif                 ${SGR.reset + SGR.dim}-> ${SGR.reset}diff
${SGR.cyan}lg                  ${SGR.reset + SGR.dim}-> ${SGR.reset}log (auto-expanded)
${SGR.cyan}pl, pu              ${SGR.reset + SGR.dim}-> ${SGR.reset}pull
${SGR.cyan}ps, pus             ${SGR.reset + SGR.dim}-> ${SGR.reset}push
${SGR.cyan}rb, rebas           ${SGR.reset + SGR.dim}-> ${SGR.reset}rebase
${SGR.cyan}res, rese           ${SGR.reset + SGR.dim}-> ${SGR.reset}reset
${SGR.cyan}rv, rever           ${SGR.reset + SGR.dim}-> ${SGR.reset}revert
${SGR.cyan}mg, mer             ${SGR.reset + SGR.dim}-> ${SGR.reset}merge
${SGR.cyan}in, ini             ${SGR.reset + SGR.dim}-> ${SGR.reset}init
${SGR.cyan}sta, st             ${SGR.reset + SGR.dim}-> ${SGR.reset}stash
${SGR.cyan}s, stat             ${SGR.reset + SGR.dim}-> ${SGR.reset}status
${SGR.cyan}swit, sw            ${SGR.reset + SGR.dim}-> ${SGR.reset}switch

${SGR.bright + _2PointGradient('CUSTOM COMMANDS', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
${formatShortCmdList(COMMAND_HELP_MAP, { cyan: SGR.cyan, reset: SGR.reset })}

${SGR.bright + _2PointGradient('GIT COMMAND EXTENSIONS', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
${formatShortCmdList(EXTENSION_HELP_MAP, { cyan: SGR.cyan, reset: SGR.reset })}

Run \`${SGR.cyan}${EXECUTABLE_NAME} ghelp <command>${SGR.reset}\` for detailed help on a specific command.

${SGR.bright + _2PointGradient('OPTIONS', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
${SGR.cyan}--init <shell>         ${SGR.reset}Output shell initialization script for given shell.
${SGR.cyan}--bypass               ${SGR.reset}Bypass gdx and execute git directly with the provided arguments.
${SGR.cyan}--no-enhance           ${SGR.reset}Bypass gdx enhanced Git's output.
${SGR.cyan}--loglevel <level>     ${SGR.reset}Set log level (error, warning, info, debug).
${SGR.cyan}--ghelp,               ${SGR.reset}Show GDX help message. ${SGR.dim}(use \`${SGR.cyan}ghelp <command>${SGR.reset}\`
${SGR.cyan}  --gdx-help, -gh      ${SGR.reset + SGR.dim}for command-specific help)${SGR.reset}
${SGR.cyan}-r, --recursive        ${SGR.yellow}[For '${EXECUTABLE_NAME} status']${SGR.reset} Recursively show git status of submodules.
${SGR.cyan}-au                    ${SGR.yellow}[For '${EXECUTABLE_NAME} pull']${SGR.reset} Shorthand for ${SGR.cyan}--allow-unrelated-histories${SGR.reset}.
${SGR.cyan}--no-lint              ${SGR.yellow}[For '${EXECUTABLE_NAME} push']${SGR.reset} Skip linting for this push${SGR.reset}.
${SGR.cyan}-fl                    ${SGR.yellow}[For '${EXECUTABLE_NAME} push']${SGR.reset} Shorthand for ${SGR.cyan}--force-with-lease${SGR.reset}.
${SGR.cyan}-h                     ${SGR.yellow}[For '${EXECUTABLE_NAME} reset']${SGR.reset} Shorthand for ${SGR.cyan}--hard${SGR.reset}.
${SGR.cyan}-s                     ${SGR.yellow}[For '${EXECUTABLE_NAME} reset']${SGR.reset} Shorthand for ${SGR.cyan}--soft${SGR.reset}.

${SGR.bright + _2PointGradient('RELATIVE REF EXPANSION', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
Expansions are triggered by specific shorthand patterns in the arguments. When detected, they are expanded to their full form before being passed to git.

Syntax:
  [origin|head]~[<number>] (e.g. ${SGR.cyan}~3${SGR.reset}, ${SGR.cyan}origin~2${SGR.reset})
  - origin~N expansions resolve relative to the current branch's upstream (e.g. origin~2 -> upstream~2).
  - ~N or head~N expansions resolve relative to HEAD (e.g. ~3 -> HEAD~3).
  - [head] and <number> can be omitted, they will default to HEAD and 0 respectively (e.g. ${SGR.cyan}origin~${SGR.reset} -> upstream, ${SGR.cyan}~${SGR.reset} -> HEAD).

Examples:
- ${SGR.cyan}${EXECUTABLE_NAME} reset ~3${SGR.reset} expands to ${SGR.cyan}${EXECUTABLE_NAME} reset HEAD~3${SGR.reset}.
- ${SGR.cyan}${EXECUTABLE_NAME} reset -h${SGR.reset} expands to ${SGR.cyan}${EXECUTABLE_NAME} reset --hard${SGR.reset}.
- ${SGR.cyan}${EXECUTABLE_NAME} show origin ~2${SGR.reset} expands to ${SGR.cyan}${EXECUTABLE_NAME} show <upstream>~2${SGR.reset}.
- ${SGR.cyan}${EXECUTABLE_NAME} diff origin ~2${SGR.reset} expands to ${SGR.cyan}${EXECUTABLE_NAME} diff <upstream>~2${SGR.reset}.

${SGR.bright + _2PointGradient('NOTES & SAFETY', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
- Help message for individual custom commands is available via
   ${SGR.cyan}${EXECUTABLE_NAME} ghelp <command>${SGR.reset} (e.g. ${SGR.cyan}${EXECUTABLE_NAME} ghelp stash${SGR.reset}).
- Range notation must be numeric and in the form start..end (e.g. 2..6).
- The wrapper prints an auto-expansion message when it expands a shorthand.
- If you rely on advanced argument parsing or unusual ${EXECUTABLE_NAME} flags, you can
   bypass expansions by using the full command name
   so they are not recognized as shorthand triggers.
- For more infomation, see ${hyperlink('README.md', REPO_README_URL)}.`,
            Math.min(100, global.terminalWidth - 4),
            {
               mode: 'softboundary',
               indent: 2,
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

   const h = COMMAND_HELP_MAP[cmdName] || EXTENSION_HELP_MAP[cmdName];
   let message = '';
   if (h && h.long) message = h.long();
   if (message && h.usage)
      message +=
         '\n\n  ' +
         SGR.bright +
         _2PointGradient('USAGE', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) +
         SGR.reset +
         '\n' +
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
         colors.cyan +
            strJustify(cmd, FIRST_COL_WIDTH, {
               overflow: 'visible',
               align: 'left',
               redundancyLv: 0,
            }) +
            colors.reset +
            strWrap(h.short, 60, {
               indent: FIRST_COL_WIDTH,
               firstIndent: 0,
               redundancyLv: 0,
               mode: 'softboundary',
            })
      );
   }
   return res.join('\n');
}

export const structure = {
   $root: Object.keys(COMMAND_HELP_MAP).concat(Object.keys(EXTENSION_HELP_MAP)),
} as const satisfies CommandStructure;
