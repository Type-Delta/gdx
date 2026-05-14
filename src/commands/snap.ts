import { ncc, strJustify, strWrap } from '@lib/Tools';

import { CommandHelpObj, CommandStructure, GdxContext } from '@/common/types';
import { EXECUTABLE_NAME, GDX_VPALETTE, SNAP_SHORT_HASH_LENGTH } from '@/consts';
import global from '@/global';
import { _2PointGradient } from '@/modules/graphics';
import {
   applySnapshot,
   createFullSnapshot,
   createWorktreeSnapshot,
   listSnapshots,
} from '@/modules/snap';
import Logger from '@/utils/logger';
import litedent from '@/utils/litedent';
import { progressiveMatch, quickPrint } from '@/utils/utilities';

const SUBCOMMANDS = ['worktree', 'full', 'list', 'apply'];

/**
 * Creates, lists, and applies repository snapshot archives.
 * @param ctx - GDX execution context.
 * @returns Exit code.
 */
export default async function snap(ctx: GdxContext): Promise<number> {
   const args = ctx.args.slice(0);
   const inputCommand = args[1]?.toLowerCase() || '';
   const { match: subcommand, candidates } = progressiveMatch(inputCommand, SUBCOMMANDS);

   try {
      switch (subcommand) {
         case null:
            if (inputCommand !== '' && !inputCommand.startsWith('-')) {
               quickPrint(help.usage());
               return 0;
            }
         case 'worktree': {
            const result = await createWorktreeSnapshot(ctx.git$);
            printCreatedSnapshot(result.hash, result.meta.type, result.meta.createdAt, result.existed);
            return 0;
         }
         case 'full': {
            const result = await createFullSnapshot(ctx.git$);
            printCreatedSnapshot(result.hash, result.meta.type, result.meta.createdAt, result.existed);
            return 0;
         }
         case 'list': {
            const snapshots = await listSnapshots(ctx.git$);
            if (snapshots.length === 0) {
               quickPrint(`${ncc('Yellow')}No snapshots found.${ncc()}`);
               return 0;
            }

            const hashWidth = SNAP_SHORT_HASH_LENGTH + 2;
            quickPrint(
               `${ncc('Bright')}${strJustify('Hash', hashWidth, { align: 'left', overflow: 'visible', redundancyLv: 0 })}${strJustify('Type', 11, { align: 'left', overflow: 'visible', redundancyLv: 0 })}${strJustify('Created', 23, { align: 'left', overflow: 'visible', redundancyLv: 0 })}Repo${ncc()}`
            );

            for (const snapshot of snapshots) {
               quickPrint(
                  `${ncc('Cyan')}${strJustify(snapshot.hash.slice(0, SNAP_SHORT_HASH_LENGTH), hashWidth, { align: 'left', overflow: 'visible', redundancyLv: 0 })}${ncc()}${strJustify(snapshot.meta.type, 11, { align: 'left', overflow: 'visible', redundancyLv: 0 })}${strJustify(formatDateTime(snapshot.meta.createdAt), 23, { align: 'left', overflow: 'visible', redundancyLv: 0 })}${snapshot.meta.repoLabel}`
               );
            }
            return 0;
         }
         case 'apply': {
            const force = !!args.popOption('--force', 2);
            const targets = args.slice(2).filter(Boolean);

            if (targets.length !== 1) {
               Logger.error('Usage: gdx snap apply <hash> [--force]', 'snap');
               return 1;
            }

            const applied = await applySnapshot(ctx.git$, targets[0], force);
            quickPrint(
               `${ncc('Green')}Applied snapshot ${applied.hash.slice(0, SNAP_SHORT_HASH_LENGTH)}${ncc()} ${ncc('Dim')}(${applied.meta.type})${ncc()}`
            );
            return 0;
         }
         default:
            if (candidates && candidates.length > 0) {
               Logger.warn(
                  `Ambiguous command '${inputCommand}'. Did you mean one of: ${candidates.join(', ')}?`,
                  'snap'
               );
            }
            quickPrint(help.usage());
            return 0;
      }
   } catch (err) {
      Logger.error(err instanceof Error ? err.message : String(err), 'snap');
      return 1;
   }
}

function printCreatedSnapshot(
   hash: string,
   type: 'worktree' | 'full',
   createdAt: string,
   existed: boolean
): void {
   const shortHash = hash.slice(0, SNAP_SHORT_HASH_LENGTH);
   const verb = existed ? 'Reused' : 'Created';
   quickPrint(
      `${ncc('Green')}${verb}${ncc()} ${type} snapshot ${ncc('Cyan')}${shortHash}${ncc()} ${ncc('Dim')}(${formatDateTime(createdAt)})${ncc()}`
   );
}

function formatDateTime(value: string): string {
   return value.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

export const help = {
   long: () => {
      const bright = ncc('Bright');
      const cyan = ncc('Cyan');
      const reset = ncc();
      return strWrap(
         litedent`
         ${bright + _2PointGradient('SNAP', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
         Create, list, and apply portable repository snapshots.

         ${bright + _2PointGradient('DESCRIPTION', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
         ${cyan}${EXECUTABLE_NAME} snap worktree${reset} stores the current HEAD, staged changes, unstaged changes,
         and untracked non-ignored files in a single archive.

         ${cyan}${EXECUTABLE_NAME} snap full${reset} stores a full backup of the repository git data in a single archive.

         ${cyan}${EXECUTABLE_NAME} snap list${reset} lists snapshots for the current repository, or every snapshot when
         invoked outside a repository.

         ${cyan}${EXECUTABLE_NAME} snap apply <hash>${reset} restores a snapshot by unique hash prefix.
         Applying over a dirty worktree requires ${cyan}--force${reset}. Full snapshots require ${cyan}--force${reset}
         when replacing an existing repository.
         `,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            indent: '  ',
            mode: 'softboundary',
         }
      );
   },
   short: 'Create, list, and apply portable worktree/full repository snapshots.',
   usage: () => {
      const cyan = ncc('Cyan');
      const dim = ncc('Dim');
      const reset = ncc();
      return strWrap(
         litedent`
         ${cyan}${EXECUTABLE_NAME} snap [worktree]${reset}
         ${cyan}${EXECUTABLE_NAME} snap full${reset}
         ${cyan}${EXECUTABLE_NAME} snap list${reset}
         ${cyan}${EXECUTABLE_NAME} snap apply <hash> ${dim}[--force]${reset}

         Examples:
            ${cyan}${EXECUTABLE_NAME} snap worktree${reset + dim} # Save current staged/unstaged/untracked state${reset}
            ${cyan}${EXECUTABLE_NAME} snap full${reset + dim}     # Save a full git-data backup${reset}
            ${cyan}${EXECUTABLE_NAME} snap list${reset + dim}     # Show available snapshots${reset}
            ${cyan}${EXECUTABLE_NAME} snap apply a1b2c3d --force${reset + dim} # Restore a snapshot${reset}`,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            indent: '  ',
            mode: 'softboundary',
         }
      );
   },
} as const satisfies CommandHelpObj;

export const structure = {
   $root: {
      worktree: {},
      full: {},
      list: {},
      apply: {
         $allOf: ['--force'],
      },
   },
} as const satisfies CommandStructure;
