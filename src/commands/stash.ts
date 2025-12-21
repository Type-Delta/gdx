import { ncc } from "@lib/Tools";
import { $inherit } from "../utils/shell";
import { quickPrint } from "../utils/utilities";




async function dropRange(git$: string, args: string[]): Promise<number> {
   const [start, end] = args[2]
      .split('..')
      .map(s => parseInt(s, 10));

   if (isNaN(start) || isNaN(end) || start > end) {
      quickPrint(ncc('Red') + `Invalid stash range: ${args[2]}` + ncc());
      return 1;
   }

   quickPrint(
      ncc('Cyan') + `Dropping stashes from ${ncc('Bright') + start + ncc() + ncc('Cyan')} to ${ncc('Bright') + end + ncc() + ncc('Cyan')} (inclusive)` + ncc()
   );
   for (let i = end; i >= start; i--) {
      await $inherit`${git$} stash drop stash@{${i}}`;
   }

   return 0;
}

export default {
   dropRange
}
