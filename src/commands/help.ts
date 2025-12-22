import dedent from 'dedent';

import { ncc } from '@lib/Tools';

import { COLOR, EXECUTABLE_NAME } from '@/consts';
import { quickPrint } from '@/utils/utilities';
import { _2PointGradient } from '@/utils/graphics';

import { help as stashHelp } from './stash';
import { help as statsHelp } from './stats';
import { help as graphHelp } from './graph';
import { help as nocapHelp } from './nocap';
import { help as parallelHelp } from './parallel';
import { help as gdxConfigHelp } from './gdx-config';
import { help as commitHelp } from './commit';
import { help as clearHelp } from './clear';

export default function help(name?: string): number {
   if (!name) {
      // @LINK: dn2jka text literal in spec
      quickPrint(
         dedent`
         ─────────────────
         ${ncc('Bright') + _2PointGradient('GDX (Git Developer eXperience)', COLOR.OceanDeepBlue, COLOR.OceanGreen, 0.12, 0.83)}
         ─────────────────
         Git, but with better DX. The raw power of Git,
         aligned with human workflows.

         NAME
         ${EXECUTABLE_NAME} (wrapper) — shorthand-friendly wrapper for git (executable) with common shortcuts,
         stash-range support, and convenience expansions.

         SYNOPSIS
         ${EXECUTABLE_NAME} <command> [<args>]
         Examples:
            ${EXECUTABLE_NAME} st           # shorthand for ${EXECUTABLE_NAME} stash
            ${EXECUTABLE_NAME} lg           # shorthand for ${EXECUTABLE_NAME} log --oneline --graph --all --decorate
            ${EXECUTABLE_NAME} stash d 2..6 # drop stashes 2 through 6 (safe: drops high->low)
            ${EXECUTABLE_NAME} clear        # backup changes to a temp patch file and reset working directory (use \`${EXECUTABLE_NAME} clear pardon\` to restore)
            ${EXECUTABLE_NAME} cmi auto     # generate commit message based on staged changes using LLM

         DESCRIPTION
         This wrapper provides short, ergonomic aliases for common ${EXECUTABLE_NAME} commands,
         automatic argument expansion for a few patterns, and utilities for
         manipulating stashes and logs. It forwards unrecognized commands/args to
         ${EXECUTABLE_NAME}.exe unchanged.

         KEY FEATURES
         - Many short aliases for common commands (commit, branch, checkout, etc.).
         - Smart expansions:
            - log: ${EXECUTABLE_NAME} lg -> ${EXECUTABLE_NAME} log --oneline --graph --all --decorate
            - log export: ${EXECUTABLE_NAME} lg export [extra args] creates a nicely formatted
               export (adds --author if missing).
            - pull: ${EXECUTABLE_NAME} pl -au -> expands -au to --allow-unrelated-histories.
            - push: ${EXECUTABLE_NAME} ps -fl -> expands -fl to --force-with-lease.
            - reset: ${EXECUTABLE_NAME} res -h -> ${EXECUTABLE_NAME} reset --hard; ${EXECUTABLE_NAME} res ~3 -> ${EXECUTABLE_NAME} reset HEAD~3
         - Clear convenience:
               - ${EXECUTABLE_NAME} clear -> creates a timestamped patch backup in the system temp folder, then resets the working directory (${EXECUTABLE_NAME} reset --hard + ${EXECUTABLE_NAME} clean -fd).
               - Use \`${EXECUTABLE_NAME} clear pardon\` to apply the latest backup patch and restore changes. Add \`-f\`/\`--force\` to bypass dirty-working-directory prompts.
         - Stash convenience:
               - Short forms: ${EXECUTABLE_NAME} sta / ${EXECUTABLE_NAME} st for stash; ${EXECUTABLE_NAME} sta l -> stash list.
               - ${EXECUTABLE_NAME} stash d 2..6 — drops stash@{6}..stash@{2} (drops high→low to
               avoid index shift).
               - ${EXECUTABLE_NAME} stash clear still supported to remove all stashes.
               - Supports apply, pop, drop, list, show, clear via short forms.
         - Informative feedback when an alias is expanded.
            - Parallel worktrees:
               - ${EXECUTABLE_NAME} parallel fork/remove/join/switch/list for temp-backed worktree workflows.
            - Parallel worktrees:
               - ${EXECUTABLE_NAME} parallel fork/remove/join/switch/list for temp-backed worktree workflows.

         SHORTHAND LIST (common)
         ad              -> add
         bra, br         -> branch
         clear           -> clear (backup changes and reset working directory; use \`pardon\` to restore)
         cl, clo         -> clone
         com, comm, cmi  -> commit
         che, checko, co -> checkout
         dif             -> diff
         lg, lo          -> log (auto-expanded)
         pl, pul         -> pull
         ps, pus         -> push
         rb, rebas       -> rebase
         res, rese       -> reset
         rv, rever       -> revert
         mg, merg        -> merge
         in, ini         -> init
         sta, st         -> stash
         s, stat         -> status
         swit, sw        -> switch

         CUSTOM COMMAND LIST
         clear           -> backup changes to a temp patch file and reset working directory
         stats           -> show user contribution statistics
         graph           -> show contribution graph
         nocap           -> generate a funny Gen-Z style comment for the latest commit by your commit author
         parallel        -> manage forked worktrees (fork/remove/join/switch/list)

         STASH USAGE EXAMPLES
         ${EXECUTABLE_NAME} stash l
            Show stash list (alias for ${EXECUTABLE_NAME} stash list).

         ${EXECUTABLE_NAME} stash d 3
            Drop stash@{3}.

         ${EXECUTABLE_NAME} stash d 2..5
            Drop stash@{5}, stash@{4}, stash@{3}, stash@{2} (safe ordering).

         ${EXECUTABLE_NAME} stash p 1
            Pop stash@{1}.

         ${EXECUTABLE_NAME} stash c
            Clear all stashes (maps to ${EXECUTABLE_NAME} stash clear — destructive).

         LOG EXPORT EXAMPLE
         ${EXECUTABLE_NAME} lg export --author="me@example.com"
            Generate a formatted log export file (wrapper will add default
            --author if missing and format the output for export).

         NOTES & SAFETY
         - Dropping stashes is destructive. Use -WhatIf or -Confirm with the
            wrapper if available (recommended to enable CmdletBinding(SupportsShouldProcess)).
         - Range notation must be numeric and in the form start..end (e.g. 2..6).
         - The wrapper prints an auto-expansion message when it expands a shorthand.
         - If you rely on advanced argument parsing or unusual ${EXECUTABLE_NAME} flags, you can
            bypass expansions by using the full command name or quoting/ordering args
            so they are not recognized as shorthand triggers.`
      );
      return 0;
   }

   const cmdName = name.replace(/^\/+/, '');
   const HELP_MAP: Record<string, any> = {
      stash: stashHelp,
      stats: statsHelp,
      graph: graphHelp,
      nocap: nocapHelp,
      parallel: parallelHelp,
      'gdx-config': gdxConfigHelp,
      gdx_config: gdxConfigHelp,
      commit: commitHelp,
      clear: clearHelp,
   };

   if (cmdName === 'help') {
      // Show the full built-in help when requesting help for 'help'
      return help();
   }

   const h = HELP_MAP[cmdName];
   if (h && h.long) {
      quickPrint(h.long);
      return 0;
   }

   // @LINK: dnn2j2k text literal in spec
   quickPrint(`No help found for '${cmdName}'.`);
   return 1;
}
