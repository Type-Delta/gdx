import { ncc } from "@lib/Tools";
import { $inherit } from "../utils/shell";
import { progressiveMatch, quickPrint } from "../utils/utilities";




async function dropRange(git$: string, args: string[]): Promise<number> {
   const [start, end] = args[2]
      .split('..')
      .map(s => parseInt(s, 10));

   if (isNaN(start) || isNaN(end) || start > end) {
      throw new Error('Invalid stash drop range.');
   }

   quickPrint(
      ncc('Cyan') + `Dropping stashes from ${ncc('Bright') + start + ncc() + ncc('Cyan')} to ${ncc('Bright') + end + ncc() + ncc('Cyan')} (inclusive)` + ncc()
   );
   for (let i = end; i >= start; i--) {
      const { code } = await $inherit`${git$} stash drop stash@{${i}}`;

      if (code !== 0) {
         console.error(ncc('Red') + `Failed to drop stash@{${i}}` + ncc());
         return 1;
      }
   }

   return 0;
}

export default {
   dropRange
}
