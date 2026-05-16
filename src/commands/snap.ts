import { ncc, strJustify, strWrap } from '@lib/Tools';

import { CommandHelpObj, CommandStructure, GdxContext } from '@/common/types';
import { EXECUTABLE_NAME, GDX_VPALETTE, SNAP_SHORT_HASH_LENGTH } from '@/consts';
import global from '@/global';
import { revParseCached } from '@/modules/git';
import { _2PointGradient } from '@/modules/graphics';
import {
   applySnapshot,
   createFullSnapshot,
   createWorktreeSnapshot,
   dropSnapshots,
   exportSnapshot,
   importSnapshot,
   listSnapshots,
   popSnapshot,
} from '@/modules/snap';
import Logger from '@/utils/logger';
import litedent from '@/utils/litedent';
import { progressiveMatch, quickPrint } from '@/utils/utilities';

const SUBCOMMANDS = ['worktree', 'full', 'list', 'apply', 'pop', 'drop', 'import', 'export'];

/**
 * Creates, lists, applies, removes, imports, and exports repository snapshot archives.
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
            if (!(await isInsideGitRepository(ctx.git$))) {
               Logger.warn('Worktree snapshots require running inside a git repository.', 'snap');
               return 0;
            }

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
            const indexWidth = Math.max(4, String(snapshots.length - 1).length + 2);
            quickPrint(
               `${ncc('Bright')}${strJustify('#', indexWidth, { align: 'left', overflow: 'visible', redundancyLv: 0 })}${strJustify('Hash', hashWidth, { align: 'left', overflow: 'visible', redundancyLv: 0 })}${strJustify('Type', 11, { align: 'left', overflow: 'visible', redundancyLv: 0 })}${strJustify('Created', 23, { align: 'left', overflow: 'visible', redundancyLv: 0 })}Repo${ncc()}`
            );

            for (const [index, snapshot] of snapshots.entries()) {
               quickPrint(
                  `${strJustify(String(index), indexWidth, { align: 'left', overflow: 'visible', redundancyLv: 0 })}${ncc('Cyan')}${strJustify(snapshot.hash.slice(0, SNAP_SHORT_HASH_LENGTH), hashWidth, { align: 'left', overflow: 'visible', redundancyLv: 0 })}${ncc()}${strJustify(snapshot.meta.type, 11, { align: 'left', overflow: 'visible', redundancyLv: 0 })}${strJustify(formatDateTime(snapshot.meta.createdAt), 23, { align: 'left', overflow: 'visible', redundancyLv: 0 })}${snapshot.meta.repoLabel}`
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
         case 'pop': {
            const force = !!args.popOption('--force', 2);
            const targets = args.slice(2).filter(Boolean);

            if (targets.length !== 1) {
               Logger.error('Usage: gdx snap pop <hash> [--force]', 'snap');
               return 1;
            }

            const popped = await popSnapshot(ctx.git$, targets[0], force);
            quickPrint(
               `${ncc('Green')}Popped snapshot ${popped.hash.slice(0, SNAP_SHORT_HASH_LENGTH)}${ncc()} ${ncc('Dim')}(${popped.meta.type})${ncc()}`
            );
            return 0;
         }
         case 'drop': {
            const targets = args.slice(2).filter(Boolean);

            if (targets.length === 0) {
               Logger.error('Usage: gdx snap drop <hash|~index|range> [...<hash|~index|range>]', 'snap');
               return 1;
            }

            const dropped = await dropSnapshots(ctx.git$, targets);
            const suffix = dropped.length === 1 ? '' : 's';
            quickPrint(`${ncc('Green')}Dropped ${dropped.length} snapshot${suffix}${ncc()}`);
            return 0;
         }
         case 'import': {
            const targets = args.slice(2).filter(Boolean);

            if (targets.length !== 1) {
               Logger.error('Usage: gdx snap import <snapshot-path>', 'snap');
               return 1;
            }

            const imported = await importSnapshot(targets[0]);
            quickPrint(
               `${ncc('Green')}Imported snapshot ${imported.hash.slice(0, SNAP_SHORT_HASH_LENGTH)}${ncc()} ${ncc('Dim')}(${imported.meta.type})${ncc()}`
            );
            return 0;
         }
         case 'export': {
            const targets = args.slice(2).filter(Boolean);

            if (targets.length !== 2) {
               Logger.error('Usage: gdx snap export <hash> <dest>', 'snap');
               return 1;
            }

            const exported = await exportSnapshot(ctx.git$, targets[0], targets[1]);
            quickPrint(
               `${ncc('Green')}Exported snapshot ${exported.snapshot.hash.slice(0, SNAP_SHORT_HASH_LENGTH)}${ncc()} ${ncc('Dim')}(${exported.destinationPath})${ncc()}`
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

async function isInsideGitRepository(git$: string | string[]): Promise<boolean> {
   try {
      return (await revParseCached(git$, ['--is-inside-work-tree'])).trim() === 'true';
   } catch {
      return false;
   }
}

export const help = {
   long: () => {
      const bright = ncc('Bright');
      const cyan = ncc('Cyan');
      const reset = ncc();
      return strWrap(
         litedent`
         ${bright + _2PointGradient('SNAP', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
         Create, list, apply, remove, import, and export portable repository snapshots.

         ${bright + _2PointGradient('DESCRIPTION', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
         ${cyan}${EXECUTABLE_NAME} snap worktree${reset} stores the current HEAD, staged changes, unstaged changes,
         and untracked non-ignored files in a single archive.

         ${cyan}${EXECUTABLE_NAME} snap full${reset} stores a full backup of the repository git data in a single archive.

         ${cyan}${EXECUTABLE_NAME} snap list${reset} lists snapshots for the current repository, or every snapshot when
         invoked outside a repository.

         ${cyan}${EXECUTABLE_NAME} snap apply <hash|~index>${reset} restores a snapshot by hash prefix or list index.
         ${cyan}${EXECUTABLE_NAME} snap pop <hash|~index>${reset} restores a snapshot and removes it after a successful apply.
         Applying or popping over a dirty worktree requires ${cyan}--force${reset}. Full snapshots require
         ${cyan}--force${reset} when replacing an existing repository.

         ${cyan}${EXECUTABLE_NAME} snap drop <hash|~index|range> [...<hash|~index|range>]${reset} removes snapshots. Ranges are inclusive
         list indexes, such as ${cyan}2..6${reset} or ${cyan}3..${reset}.

         ${cyan}${EXECUTABLE_NAME} snap import <snapshot-path>${reset} copies a .gdxsnap archive into local snapshot storage.

         ${cyan}${EXECUTABLE_NAME} snap export <hash|~index> <dest>${reset} copies a snapshot to a directory or explicit .gdxsnap path.
         `,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            indent: '  ',
            mode: 'softboundary',
         }
      );
   },
   short: 'Create, list, apply, remove, import, and export portable repository snapshots.',
   usage: () => {
      const cyan = ncc('Cyan');
      const dim = ncc('Dim');
      const reset = ncc();
      return strWrap(
         litedent`
         ${cyan}${EXECUTABLE_NAME} snap [worktree]${reset}
         ${cyan}${EXECUTABLE_NAME} snap full${reset}
         ${cyan}${EXECUTABLE_NAME} snap list${reset}
         ${cyan}${EXECUTABLE_NAME} snap apply <hash|~index> ${dim}[--force]${reset}
         ${cyan}${EXECUTABLE_NAME} snap pop <hash|~index> ${dim}[--force]${reset}
         ${cyan}${EXECUTABLE_NAME} snap drop <hash|~index|range> ${dim}[...targets]${reset}
         ${cyan}${EXECUTABLE_NAME} snap import <snapshot-path>${reset}
         ${cyan}${EXECUTABLE_NAME} snap export <hash|~index> <dest>${reset}

         Examples:
            ${cyan}${EXECUTABLE_NAME} snap worktree${reset + dim} # Save current staged/unstaged/untracked state${reset}
            ${cyan}${EXECUTABLE_NAME} snap full${reset + dim}     # Save a full git-data backup${reset}
            ${cyan}${EXECUTABLE_NAME} snap list${reset + dim}     # Show available snapshots${reset}
            ${cyan}${EXECUTABLE_NAME} snap apply a1b2c3d --force${reset + dim} # Restore a snapshot${reset}
            ${cyan}${EXECUTABLE_NAME} snap apply ~ --force${reset + dim}       # Restore newest listed snapshot${reset}
            ${cyan}${EXECUTABLE_NAME} snap pop a1b2c3d --force${reset + dim}   # Restore and remove a snapshot${reset}
            ${cyan}${EXECUTABLE_NAME} snap drop 2..6 ~0${reset + dim}          # Remove snapshots by index range and selector${reset}
            ${cyan}${EXECUTABLE_NAME} snap export a1b2c3d ./snapshots${reset + dim} # Copy out a snapshot archive${reset}`,
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
      pop: {
         $allOf: ['--force'],
      },
      drop: {},
      import: {},
      export: {},
   },
} as const satisfies CommandStructure;
