import dedent from 'dedent';

import { ncc } from '@lib/Tools';

import { $inherit } from '../utils/shell';
import { quickPrint } from '../utils/utilities';
import { EXECUTABLE_NAME } from '@/consts';

async function dropRange(git$: string | string[], args: string[]): Promise<number> {
   const [start, end] = args[2].split('..').map((s) => parseInt(s, 10));

   if (isNaN(start) || isNaN(end) || start > end) {
      quickPrint(ncc('Red') + `Invalid stash range: ${args[2]}` + ncc());
      return 1;
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

export default {
   dropRange,
};

export const help = {
   long: dedent(`${ncc('Cyan')}stash drop - Remove a contiguous range of stash entries${ncc()}

      ${ncc('Bright')}What it does:${ncc()} Accepts a range in the form <start>..<end> and drops each stash
      entry in that inclusive range. The routine validates the numeric range and iterates from the highest
      index down to the lowest to avoid reindexing issues when dropping multiple stashes.

      ${ncc('Bright')}Safety:${ncc()} This operation is destructive: dropped stashes cannot be recovered by
      this tool. Ensure you really want to delete the specified range. Use \`git stash list\` to inspect
      entries before running.
   `),
   short: 'Drop a contiguous range of stash entries (e.g. 0..3).',
   usage: dedent(`
      ${EXECUTABLE_NAME} stash drop <start>..<end>

      Examples:
        ${EXECUTABLE_NAME} stash drop 0..0            # Drop the most recent stash
        ${EXECUTABLE_NAME} stash drop 2..5            # Drop stashes 2,3,4,5 (inclusive)
   `),
};
