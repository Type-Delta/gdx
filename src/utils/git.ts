import { ncc } from '@lib/Tools';
import { quickPrint } from './utilities';
import { $ } from './shell';

export async function assertInGitWorktree(git$: string | string[]): Promise<boolean> {
   try {
      await $`${git$} rev-parse --is-inside-work-tree`;
   } catch {
      quickPrint(ncc('Red') + 'Error: This command must be run inside a git repository.' + ncc());
      return false;
   }
   return true;
}

/**
 * Retrieves the SHA and message of a stash entry.
 */
export async function getStashEntry(git$: string | string[], index: number): Promise<{ sha: string, message: string } | null> {
   try {
      const ref = `stash@{${index}}`;
      const { stdout: sha } = await $`${git$} rev-parse ${ref}`;
      const { stdout: message } = await $`${git$} log -1 --format=%s ${ref}`;
      return { sha: sha.trim(), message: message.trim() };
   } catch {
      return null;
   }
}

/**
 * Restores a stash entry using `git stash store`.
 */
export async function restoreStash(git$: string | string[], sha: string, message: string): Promise<void> {
   await $`${git$} stash store -m ${message} ${sha}`;
}
