import { strJustify, strWrap } from '@lib/Tools';

import { CommandHelpObj, CommandStructure, GdxContext } from '@/common/types';
import { EXECUTABLE_NAME, GDX_VPALETTE, SNAP_SHORT_HASH_LENGTH, SGR } from '@/consts';
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
            const message = popSnapshotMessage(args, subcommand === 'worktree' ? 2 : 1);
            if (message === null) {
               Logger.error('Usage: gdx snap [worktree] [-m|--message <message>]', 'snap');
               return 1;
            }

            if (!(await isInsideGitRepository(ctx.git$))) {
               Logger.warn('Worktree snapshots require running inside a git repository.', 'snap');
               return 0;
            }

            const result = await createWorktreeSnapshot(ctx.git$, message);
            printCreatedSnapshot(
               result.hash,
               result.meta.type,
               result.meta.createdAt,
               result.existed
            );
            return 0;
         }
         case 'full': {
            const message = popSnapshotMessage(args, 2);
            if (message === null) {
               Logger.error('Usage: gdx snap full [-m|--message <message>]', 'snap');
               return 1;
            }

            const result = await createFullSnapshot(ctx.git$, message);
            printCreatedSnapshot(
               result.hash,
               result.meta.type,
               result.meta.createdAt,
               result.existed
            );
            return 0;
         }
         case 'list': {
            const snapshots = await listSnapshots(ctx.git$);
            if (snapshots.length === 0) {
               quickPrint(`${SGR.yellow}No snapshots found.${SGR.reset}`);
               return 0;
            }

            const hashWidth = SNAP_SHORT_HASH_LENGTH + 2;
            const indexWidth = Math.max(4, String(snapshots.length - 1).length + 2);
            quickPrint(
               `${SGR.bright}${strJustify('#', indexWidth, { align: 'left', overflow: 'visible', redundancyLv: 0 })}${strJustify('Hash', hashWidth, { align: 'left', overflow: 'visible', redundancyLv: 0 })}${strJustify('Type', 11, { align: 'left', overflow: 'visible', redundancyLv: 0 })}${strJustify('Created', 23, { align: 'left', overflow: 'visible', redundancyLv: 0 })}Message${SGR.reset}`
            );

            for (const [index, snapshot] of snapshots.entries()) {
               quickPrint(
                  `${strJustify(String(index), indexWidth, { align: 'left', overflow: 'visible', redundancyLv: 0 })}${SGR.cyan}${strJustify(snapshot.hash.slice(0, SNAP_SHORT_HASH_LENGTH), hashWidth, { align: 'left', overflow: 'visible', redundancyLv: 0 })}${SGR.reset}${strJustify(snapshot.meta.type, 11, { align: 'left', overflow: 'visible', redundancyLv: 0 })}${strJustify(formatDateTime(snapshot.meta.createdAt), 23, { align: 'left', overflow: 'visible', redundancyLv: 0 })}${snapshot.meta.message || ''}`
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
               `${SGR.green}Applied snapshot ${applied.hash.slice(0, SNAP_SHORT_HASH_LENGTH)}${SGR.reset} ${SGR.dim}(${applied.meta.type})${SGR.reset}`
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
               `${SGR.green}Popped snapshot ${popped.hash.slice(0, SNAP_SHORT_HASH_LENGTH)}${SGR.reset} ${SGR.dim}(${popped.meta.type})${SGR.reset}`
            );
            return 0;
         }
         case 'drop': {
            const targets = args.slice(2).filter(Boolean);

            if (targets.length === 0) {
               Logger.error(
                  'Usage: gdx snap drop <hash|~index|range> [...<hash|~index|range>]',
                  'snap'
               );
               return 1;
            }

            const dropped = await dropSnapshots(ctx.git$, targets);
            const suffix = dropped.length === 1 ? '' : 's';
            quickPrint(`${SGR.green}Dropped ${dropped.length} snapshot${suffix}${SGR.reset}`);
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
               `${SGR.green}Imported snapshot ${imported.hash.slice(0, SNAP_SHORT_HASH_LENGTH)}${SGR.reset} ${SGR.dim}(${imported.meta.type})${SGR.reset}`
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
               `${SGR.green}Exported snapshot ${exported.snapshot.hash.slice(0, SNAP_SHORT_HASH_LENGTH)}${SGR.reset} ${SGR.dim}(${exported.destinationPath})${SGR.reset}`
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

function popSnapshotMessage(args: GdxContext['args'], from: number): string | undefined | null {
   const message =
      args.popAssertValue('--message', from) ?? args.popAssertValue('-m', from);
   return message == null ? undefined : message;
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
      `${SGR.green}${verb}${SGR.reset} ${type} snapshot ${SGR.cyan}${shortHash}${SGR.reset} ${SGR.dim}(${formatDateTime(createdAt)})${SGR.reset}`
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
      return strWrap(
         litedent`
         ${SGR.bright + _2PointGradient('SNAP', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         Create, list, apply, remove, import, and export portable repository snapshots.

         ${SGR.bright + _2PointGradient('DESCRIPTION', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} snap worktree${SGR.reset} stores the current HEAD, staged changes, unstaged changes,
         and untracked non-ignored files in a single archive.

         ${SGR.cyan}${EXECUTABLE_NAME} snap full${SGR.reset} stores a full backup of the repository git data in a single archive.

         Use ${SGR.cyan}-m|--message <message>${SGR.reset} with ${SGR.cyan}worktree${SGR.reset} or ${SGR.cyan}full${SGR.reset} to label a snapshot.

         ${SGR.cyan}${EXECUTABLE_NAME} snap list${SGR.reset} lists snapshots for the current repository.

         ${SGR.cyan}${EXECUTABLE_NAME} snap apply <hash|~index>${SGR.reset} restores a snapshot by hash prefix or list index.
         ${SGR.cyan}${EXECUTABLE_NAME} snap pop <hash|~index>${SGR.reset} restores a snapshot and removes it after a successful apply.
         Applying or popping over a dirty worktree requires ${SGR.cyan}--force${SGR.reset}. Full snapshots require
         ${SGR.cyan}--force${SGR.reset} when replacing an existing repository.

         ${SGR.cyan}${EXECUTABLE_NAME} snap drop <hash|~index|range> [...<hash|~index|range>]${SGR.reset} removes snapshots. Ranges are inclusive
         list indexes, such as ${SGR.cyan}2..6${SGR.reset} or ${SGR.cyan}3..${SGR.reset}.

         ${SGR.cyan}${EXECUTABLE_NAME} snap import <snapshot-path>${SGR.reset} copies a .gdxsnap archive into local snapshot storage.

         ${SGR.cyan}${EXECUTABLE_NAME} snap export <hash|~index> <dest>${SGR.reset} copies a snapshot to a directory or explicit .gdxsnap path.
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
      return strWrap(
         litedent`
         ${SGR.cyan}${EXECUTABLE_NAME} snap [worktree] ${SGR.dim}[-m|--message <message>]${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} snap full ${SGR.dim}[-m|--message <message>]${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} snap list${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} snap apply <hash|~index> ${SGR.dim}[--force]${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} snap pop <hash|~index> ${SGR.dim}[--force]${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} snap drop <hash|~index|range> ${SGR.dim}[...targets]${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} snap import <snapshot-path>${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} snap export <hash|~index> <dest>${SGR.reset}

         Examples:
            ${SGR.cyan}${EXECUTABLE_NAME} snap worktree -m "wip parser"${SGR.reset + SGR.dim} # Save current staged/unstaged/untracked state${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} snap full -m "pre-upgrade"${SGR.reset + SGR.dim}     # Save a full git-data backup${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} snap list${SGR.reset + SGR.dim}     # Show available snapshots${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} snap apply a1b2c3d --force${SGR.reset + SGR.dim} # Restore a snapshot${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} snap apply ~ --force${SGR.reset + SGR.dim}       # Restore newest listed snapshot${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} snap pop a1b2c3d --force${SGR.reset + SGR.dim}   # Restore and remove a snapshot${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} snap drop 2..6 ~0${SGR.reset + SGR.dim}          # Remove snapshots by index range and selector${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} snap export a1b2c3d ./snapshots${SGR.reset + SGR.dim} # Copy out a snapshot archive${SGR.reset}`,
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
      worktree: {
         $allOf: ['-m', '--message'],
      },
      full: {
         $allOf: ['-m', '--message'],
      },
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
