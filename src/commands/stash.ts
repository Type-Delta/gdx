import litedent from 'litedent';

import { Err, strWrap } from '@lib/Tools';

import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

import { $inherit } from '../modules/shell';
import { quickPrint } from '../utils/utilities';
import { EXECUTABLE_NAME, TEMP_DIR, SGR } from '@/consts';
import { GDX_VPALETTE } from '@/consts';
import { _2PointGradient } from '@/modules/graphics';
import { getStashEntry, restoreStash, getRepoRootCached } from '@/modules/git';
import { getConfig } from '@/common/config';
import Logger from '../utils/logger';
import global from '@/global';
import { CommandHelpObj, CommandStructure } from '@/common/types';
import { ArgsSet } from '@/modules/arguments';
import { readHistoryTimeline, readHistoryTransactionManifest } from '@/modules/history/storage';
import { undoHistory } from '@/modules/history/transaction';
import { HistoryTransactionManifest } from '@/modules/history/types';

export interface StashEntry {
   sha: string;
   message: string;
   index?: number; // Original index, useful for logging
}

export interface StashDropOperation {
   timestamp: number;
   entries: StashEntry[]; // Ordered list of dropped stashes
   type: 'single' | 'range';
}

async function dropPardon(git$: string | string[]): Promise<number> {
   try {
      const root = await getRepoRootCached(git$);
      let hasCompatibleHistory = false;
      let compatibleHistory: HistoryTransactionManifest | null = null;
      try {
         const timeline = await readHistoryTimeline(git$);
         if (timeline.cursor > 0) {
            const latestId = timeline.entries[timeline.cursor - 1];
            const latest = await readHistoryTransactionManifest(git$, latestId);
            const isCompatible =
               latest?.source === 'gdx' &&
               latest.command?.command === 'stash:drop' &&
               latest.refs.some((change) => change.name === 'refs/stash');
            hasCompatibleHistory = !!isCompatible;
            compatibleHistory = isCompatible ? latest : null;
         }
      } catch (error) {
         Logger.debug(`History stash pardon unavailable: ${Err.from(error).message}`, 'stash');
      }
      if (hasCompatibleHistory) {
         const legacy = popLastStashDrop(root);
         await undoHistory({ git$, args: new ArgsSet(['history', 'undo']) });
         await rebuildStashReflog(git$, compatibleHistory!, legacy);
         quickPrint(SGR.green + 'Restored the latest stash drop from GDX history.' + SGR.reset);
         return 0;
      }
      const op = popLastStashDrop(root);

      if (!op) {
         Logger.error('No stash drop to pardon.', 'stash');
         return 1;
      }

      quickPrint(SGR.cyan + `Restoring ${op.entries.length} dropped stash(es)...` + SGR.reset);

      // Restore
      for (const entry of op.entries) {
         await restoreStash(git$, entry.sha, entry.message);
         quickPrint(SGR.green + `  + Restored: ${entry.message}` + SGR.reset);
      }

      return 0;
   } catch (e) {
      // Fallback or error
      Logger.error('Error pardoning stash: ' + e, 'stash');
      return 1;
   }
}

/** Rebuilds the stash reflog sequence after strict ref restoration. */
async function rebuildStashReflog(
   git$: string | string[],
   manifest: HistoryTransactionManifest,
   legacy: StashDropOperation | null
): Promise<void> {
   const change = manifest.refs.find((entry) => entry.name === 'refs/stash');
   if (!change) return;
   if (change.after.kind === 'missing') {
      await $inherit`${git$} update-ref -d refs/stash`;
   } else if (change.after.kind === 'oid') {
      await $inherit`${git$} update-ref refs/stash ${change.after.oid}`;
   }

   if (legacy?.entries.length) {
      for (const entry of legacy.entries) {
         await restoreStash(git$, entry.sha, entry.message);
      }
      return;
   }

   if (change.before.kind === 'oid') {
      const expected = change.after.kind === 'oid' ? change.after.oid : '';
      const args = [
         'update-ref',
         '--create-reflog',
         '-m',
         'restored by gdx history',
         'refs/stash',
         change.before.oid,
      ];
      if (expected) args.push(expected);
      await $inherit`${git$} ${args}`;
   }
}

async function dropRange(
   git$: string | string[],
   args: string[],
   stashBakLimit: number
): Promise<number> {
   const [start, end] = args[2].split('..').map((s) => parseInt(s, 10));

   if (isNaN(start) || isNaN(end) || start > end) {
      Logger.error(`Invalid stash range: ${args[2]}`, 'stash');
      return 1;
   }

   // Capture logic
   let entries: StashEntry[];
   try {
      const root = await getRepoRootCached(git$);

      // Loop high to low
      const getEntriesProms: ReturnType<typeof getStashEntry>[] = [];
      for (let i = end; i >= start; i--) {
         getEntriesProms.push(getStashEntry(git$, i));
      }

      entries = (await Promise.all(getEntriesProms)).filter((e): e is StashEntry => e != null);

      if (entries.length > 0) {
         saveStashDrop(
            root,
            {
               timestamp: Date.now(),
               entries: entries,
               type: 'range',
            },
            stashBakLimit
         );
      }
   } catch (err) {
      const error = Err.from(err);
      Logger.warn(`Could not capture stash entry for undo. (${error.name})`, 'stash');
      Logger.debug(error.toString(), 'stash');
   }

   quickPrint(
      SGR.cyan +
         `Dropping stashes from ${SGR.bright + start + SGR.reset + SGR.cyan} to ${SGR.bright + end + SGR.reset + SGR.cyan} (inclusive)` +
         SGR.reset
   );

   for (let i = end; i >= start; i--) {
      await $inherit`${git$} stash drop stash@{${i}}`;
   }

   return 0;
}

async function drop(git$: string | string[], args: string[]): Promise<number> {
   if (args[2] === 'pardon') {
      return await dropPardon(git$);
   }

   const config = await getConfig();
   const limit = config.get<number>('stash.undoLimit') ?? 10;

   // Check for range
   if (args[2] && /^\d+\.\.\d+$/.test(args[2])) {
      return await dropRange(git$, args, limit);
   }

   // Single drop
   let index = 0;
   // Try to parse index from arguments
   const nonFlagArgs = args.slice(2).filter((a) => !a.startsWith('-'));
   if (nonFlagArgs.length > 0) {
      if (nonFlagArgs[0].includes('..')) {
         // Should not happen as checked above, but safe guard
      } else {
         const match = nonFlagArgs[0].match(/stash@\{(\d+)\}/) || nonFlagArgs[0].match(/^(\d+)$/);
         if (match) index = parseInt(match[1], 10);
      }
   }

   // Capture and create undo entry
   try {
      const entry = await getStashEntry(git$, index);

      if (entry) {
         const root = await getRepoRootCached(git$);
         saveStashDrop(
            root,
            {
               timestamp: Date.now(),
               entries: [entry],
               type: 'single',
            },
            limit
         );
      }
   } catch (err) {
      Logger.warn(`Could not capture stash entry for undo. (${Err.from(err).name})`, 'stash');
   }

   // Run original command
   try {
      await $inherit`${git$} ${args}`;
      return 0;
   } catch {
      return 1;
   }
}

function getHistoryFilePath(repoPath: string): string {
   const hash = crypto.createHash('sha256').update(repoPath).digest('hex');
   const undoDir = path.join(TEMP_DIR, 'gdx', 'stash-undo');
   if (!fs.existsSync(undoDir)) {
      fs.mkdirSync(undoDir, { recursive: true });
   }
   return path.join(undoDir, `${hash}.json`);
}

function readHistory(repoPath: string): StashDropOperation[] {
   const file = getHistoryFilePath(repoPath);
   if (!fs.existsSync(file)) return [];
   try {
      const data = fs.readFileSync(file, 'utf-8');
      return JSON.parse(data);
   } catch {
      return [];
   }
}

function writeHistory(repoPath: string, history: StashDropOperation[]) {
   const file = getHistoryFilePath(repoPath);
   fs.writeFileSync(file, JSON.stringify(history, null, 2));
}

export function saveStashDrop(repoPath: string, operation: StashDropOperation, limit: number = 10) {
   const history = readHistory(repoPath);
   history.push(operation);

   // Cap at configured limit
   if (history.length > limit) {
      // Remove oldest entries until we fit the limit
      history.splice(0, history.length - limit);
   }

   writeHistory(repoPath, history);
}

export function popLastStashDrop(repoPath: string): StashDropOperation | null {
   const history = readHistory(repoPath);
   if (history.length === 0) return null;

   const operation = history.pop() || null;
   writeHistory(repoPath, history);
   return operation;
}

export default {
   dropRange,
   drop,
};

export const help = {
   long: () => {
      return strWrap(
         litedent`
         ${SGR.bright + _2PointGradient('STASH DROP', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         Remove a stash entry or a range of stash entries.

         ${SGR.bright + _2PointGradient('DESCRIPTION', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         Accepts a single stash index, a range like <start>..<end>, or defaults to the latest stash.
         Includes safety features:
         - **Undoable**: You can restore the last dropped stash(es) with \`${SGR.cyan}${EXECUTABLE_NAME} stash drop pardon${SGR.reset}\`.

         ${SGR.bright + _2PointGradient('COMMANDS', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         - \`${SGR.cyan}drop <index>${SGR.reset}\`: Drop specific stash.
         - \`${SGR.cyan}drop <start>..<end>${SGR.reset}\`: Drop range of stashes.
         - \`${SGR.cyan}drop pardon${SGR.reset}\`: Undo the last drop operation.

         ${SGR.bright + _2PointGradient('SAFETY', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         Dropped stashes are backed up temporarily. Use \`${SGR.cyan}pardon${SGR.reset}\` to bring them back.
         `,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            mode: 'softboundary',
            indent: '  ',
         }
      );
   },
   short: 'Extends git stash with ability to drop entries and undo support (e.g. 0..3, pardon).',
   usage: () => {
      return strWrap(
         litedent`
         ${SGR.cyan}${EXECUTABLE_NAME} stash drop ${SGR.dim}[<stash> | <range> | pardon]${SGR.reset}

         Examples:
            ${SGR.cyan}${EXECUTABLE_NAME} stash drop 0..0   ${SGR.reset + SGR.dim}# Drop the most recent stash${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} stash drop pardon ${SGR.reset + SGR.dim}# Restore last dropped stash${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} stash l           ${SGR.reset + SGR.dim}# Show stash list (alias for ${EXECUTABLE_NAME} stash list).${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} stash d 3         ${SGR.reset + SGR.dim}# Drop stash@{3}.${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} stash d 2..5      ${SGR.reset + SGR.dim}# Drop stash@{5}, stash@{4}, stash@{3}, stash@{2} (safe ordering).${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} stash p 1         ${SGR.reset + SGR.dim}# Pop stash@{1}.${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} stash c           ${SGR.reset + SGR.dim}# Clear all stashes (maps to ${EXECUTABLE_NAME} stash clear — destructive).${SGR.reset}`,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            mode: 'softboundary',
            indent: '  ',
         }
      );
   },
} as const satisfies CommandHelpObj;

export const structure = {
   $root: ['list', 'ls', 'pardon'],
} as const satisfies CommandStructure;
