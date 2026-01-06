import { Err, ncc, strWrap } from '@lib/Tools';

import { $inherit, $ } from '../utils/shell';
import { quickPrint } from '../utils/utilities';
import { EXECUTABLE_NAME } from '@/consts';
import { COLOR } from '@/consts';
import { _2PointGradient } from '@/utils/graphics';
import { getStashEntry, restoreStash } from '@/utils/git';
import { saveStashDrop, popLastStashDrop, StashEntry } from '@/utils/stashUndo';
import { getConfig } from '@/common/config';

async function dropPardon(git$: string | string[]): Promise<number> {
   try {
      const root = (await $`${git$} rev-parse --show-toplevel`).stdout.trim();
      const op = popLastStashDrop(root);

      if (!op) {
         quickPrint(ncc('Red') + 'No stash drop to pardon.' + ncc());
         return 1;
      }

      quickPrint(ncc('Cyan') + `Restoring ${op.entries.length} dropped stash(es)...` + ncc());

      // Restore
      for (const entry of op.entries) {
         await restoreStash(git$, entry.sha, entry.message);
         quickPrint(ncc('Green') + `  + Restored: ${entry.message}` + ncc());
      }

      return 0;
   } catch (e) {
      // Fallback or error
      quickPrint(ncc('Red') + 'Error pardoning stash: ' + e + ncc());
      return 1;
   }
}

async function dropRange(git$: string | string[], args: string[], stashBakLimit: number): Promise<number> {
   const [start, end] = args[2].split('..').map((s) => parseInt(s, 10));

   if (isNaN(start) || isNaN(end) || start > end) {
      quickPrint(ncc('Red') + `Invalid stash range: ${args[2]}` + ncc());
      return 1;
   }

   // Capture logic
   const entries: StashEntry[] = [];
   try {
      const root = (await $`${git$} rev-parse --show-toplevel`).stdout.trim();

      // Loop high to low
      for (let i = end; i >= start; i--) {
         const entry = await getStashEntry(git$, i);
         if (entry) entries.push(entry);
      }

      if (entries.length > 0) {
         saveStashDrop(root, {
            timestamp: Date.now(),
            entries: entries,
            type: 'range'
         }, stashBakLimit);
      }
   } catch (err) {
      quickPrint(ncc('Yellow') + `Warning: Could not capture stash entry for undo. (${Err.from(err).name})` + ncc());
   }

   quickPrint(
      ncc('Cyan') +
      `Dropping stashes from ${ncc('Bright') + start + ncc() + ncc('Cyan')} to ${ncc('Bright') + end + ncc() + ncc('Cyan')} (inclusive)` +
      ncc()
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
   if (args[2] && /\d+\.\.\d+$/.test(args[2])) {
      return await dropRange(git$, args, limit);
   }

   // Single drop
   let index = 0;
   // Try to parse index from arguments
   const nonFlagArgs = args.slice(2).filter(a => !a.startsWith('-'));
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
         const root = (await $`${git$} rev-parse --show-toplevel`).stdout.trim();
         saveStashDrop(root, {
            timestamp: Date.now(),
            entries: [entry],
            type: 'single'
         }, limit);
      }
   } catch (err) {
      quickPrint(ncc('Yellow') + `Warning: Could not capture stash entry for undo. (${Err.from(err).name})` + ncc());
   }

   // Run original command
   try {
      await $inherit`${git$} ${args}`;
      return 0;
   } catch {
      return 1;
   }
}

export default {
   dropRange,
   drop,
};

export const help = {
   long: () =>
      strWrap(
         `
${ncc('Bright') + _2PointGradient('STASH DROP', COLOR.Zinc400, COLOR.Zinc100, 0.2)}
Remove a stash entry or a range of stash entries.

${ncc('Bright') + _2PointGradient('DESCRIPTION', COLOR.Zinc400, COLOR.Zinc100, 0.2)}
Accepts a single stash index, a range like <start>..<end>, or defaults to the latest stash.
Includes safety features:
- **Undoable**: You can restore the last dropped stash(es) with \`gdx stash drop pardon\`.

${ncc('Bright') + _2PointGradient('COMMANDS', COLOR.Zinc400, COLOR.Zinc100, 0.2)}
- \`drop <index>\`: Drop specific stash.
- \`drop <start>..<end>\`: Drop range of stashes.
- \`drop pardon\`: Undo the last drop operation.

${ncc('Bright') + _2PointGradient('SAFETY', COLOR.Zinc400, COLOR.Zinc100, 0.2)}
Dropped stashes are backed up temporarily. Use \`pardon\` to bring them back.
`,
         100,
         {
            firstIndent: '  ',
            mode: 'softboundery',
            indent: '  ',
         }
      ),
   short: 'Drop stash entries with undo support (e.g. 0..3, pardon).',
   usage: () =>
      strWrap(
         `
${ncc('Cyan')}${EXECUTABLE_NAME} stash drop ${ncc('Dim')}[<stash> | <range> | pardon]${ncc()}

Examples:
   ${ncc('Cyan')}${EXECUTABLE_NAME} stash drop 0..0 ${ncc() + ncc('Dim')}# Drop the most recent stash${ncc()}
   ${ncc('Cyan')}${EXECUTABLE_NAME} stash drop pardon ${ncc() + ncc('Dim')}# Restore last dropped stash${ncc()}`,
         100,
         {
            firstIndent: '  ',
            mode: 'softboundery',
            indent: '  ',
         }
      ),
};
