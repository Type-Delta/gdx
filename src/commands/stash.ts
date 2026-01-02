import { ncc, strWrap } from '@lib/Tools';

import { $inherit } from '../utils/shell';
import { quickPrint } from '../utils/utilities';
import { EXECUTABLE_NAME } from '@/consts';

import { COLOR } from '@/consts';
import { _2PointGradient } from '@/utils/graphics';

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
   long: () =>
      strWrap(
         `
${ncc('Bright') + _2PointGradient('STASH DROP', COLOR.Zinc400, COLOR.Zinc100, 0.2)}
Remove a contiguous range of stash entries.

${ncc('Bright') + _2PointGradient('DESCRIPTION', COLOR.Zinc400, COLOR.Zinc100, 0.2)}
Accepts a range in the form <start>..<end> and drops each stash entry in that inclusive range. The routine validates the numeric range and iterates from the highest index down to the lowest to avoid reindexing issues when dropping multiple stashes.

${ncc('Bright') + _2PointGradient('SAFETY', COLOR.Zinc400, COLOR.Zinc100, 0.2)}
This operation is destructive: dropped stashes cannot be recovered by this tool. Ensure you really want to delete the specified range. Use \`git stash list\` to inspect entries before running.
`,
         100,
         {
            firstIndent: '  ',
            mode: 'softboundery',
            indent: '  ',
         }
      ),
   short: 'Drop a contiguous range of stash entries (e.g. 0..3).',
   usage: () =>
      strWrap(
         `
${ncc('Cyan')}${EXECUTABLE_NAME} stash drop ${ncc('Dim')}<start>..<end>${ncc()}

Examples:
   ${ncc('Cyan')}${EXECUTABLE_NAME} stash drop 0..0 ${ncc() + ncc('Dim')}# Drop the most recent stash${ncc()}
   ${ncc('Cyan')}${EXECUTABLE_NAME} stash drop 2..5 ${ncc() + ncc('Dim')}# Drop stashes 2,3,4,5 (inclusive)${ncc()}`,
         100,
         {
            firstIndent: '  ',
            mode: 'softboundery',
            indent: '  ',
         }
      ),
};
