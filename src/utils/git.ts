import { ncc } from "@lib/Tools";
import { quickPrint } from "./utilities";
import { $ } from "./shell";

export async function assertInGitWorktree(git$: string): Promise<boolean> {
   try {
      await $`${git$} rev-parse --is-inside-work-tree`;
   } catch {
      quickPrint(ncc('Red') + 'Error: This command must be run inside a git repository.' + ncc());
      return false;
   }
   return true;
}
