import path from 'path';

import * as fs from '@/modules/fs';

import Logger from '../utils/logger';
import { $ } from './shell';

/**
 * Checks if the current directory is inside a Git worktree.
 * Logs an error message if not in a Git repository.
 * @param git$ - Git executable path or command array.
 * @returns True if inside a Git worktree, false otherwise.
 */
export async function assertInGitWorktree(git$: string | string[]): Promise<boolean> {
   try {
      await $`${git$} rev-parse --is-inside-work-tree`;
   } catch {
      Logger.error('This command must be run inside a git repository.', 'git');
      return false;
   }
   return true;
}

/**
 * Retrieves the SHA and message of a stash entry.
 * @param git$ - Git executable path or command array.
 * @param index - The index of the stash entry (e.g., 0 for stash@{0}).
 * @returns An object containing the SHA and message of the stash entry, or null if not found.
 */
export async function getStashEntry(
   git$: string | string[],
   index: number
): Promise<{ sha: string; message: string } | null> {
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
 * @param git$ - Git executable path or command array.
 * @param sha - The SHA hash of the stash entry to restore.
 * @param message - The message/description for the restored stash entry.
 * @returns A promise that resolves when the stash is restored.
 */
export async function restoreStash(
   git$: string | string[],
   sha: string,
   message: string
): Promise<void> {
   await $`${git$} stash store -m ${message} ${sha}`;
}

/**
 * Normalizes a Git remote URL to a standard format.
 * Handles both SCP-like syntax (user@host:path) and standard URLs.
 * Removes .git suffix, trailing slashes, and normalizes the hostname.
 * @param rawUrl - The raw Git remote URL to normalize.
 * @returns The normalized URL in the format "host/path" or just "path" if no host.
 */
export function normalizeRemoteUrl(rawUrl: string): string {
   let trimmed = rawUrl.trim();
   if (!trimmed) return '';

   trimmed = trimmed.replace(/\\+/g, '/');

   const scpLike = trimmed.match(/^(?:[^@]+@)?([^:/]+):(.+)$/);
   if (scpLike && !trimmed.includes('://')) {
      const host = scpLike[1].toLowerCase();
      const repoPath = scpLike[2];
      return normalizeRemoteHostPath(host, repoPath);
   }

   try {
      const parsed = new URL(trimmed);
      const host = parsed.hostname.toLowerCase();
      const repoPath = parsed.pathname;
      return normalizeRemoteHostPath(host, repoPath);
   } catch {
      return normalizeRemoteHostPath('', trimmed);
   }
}

/**
 * Determines the default remote name for the current Git repository.
 * Checks the current branch's remote, falls back to 'origin', or uses the first available remote.
 * @param git$ - Git executable path or command array.
 * @returns The name of the default remote, or null if no remotes exist.
 */
export async function getDefaultRemoteName(git$: string | string[]): Promise<string | null> {
   try {
      const { stdout: remoteStdout } = await $`${git$} remote`;
      const remotes = remoteStdout
         .trim()
         .split('\n')
         .map((remote) => remote.trim())
         .filter(Boolean);

      if (remotes.length === 0) return null;

      let branchRemote = '';
      try {
         const { stdout: branchStdout } = await $`${git$} rev-parse --abbrev-ref HEAD`;
         const branchName = branchStdout.trim();
         if (branchName && branchName !== 'HEAD') {
            const { stdout: configStdout } = await $`${git$} config branch.${branchName}.remote`;
            branchRemote = configStdout.trim();
         }
      } catch {
         branchRemote = '';
      }

      if (branchRemote && remotes.includes(branchRemote)) return branchRemote;
      if (remotes.includes('origin')) return 'origin';
      return remotes[0];
   } catch {
      return null;
   }
}

/**
 * Retrieves and normalizes the URL of the default remote.
 * Combines getDefaultRemoteName and normalizeRemoteUrl to get a standardized remote URL.
 * @param git$ - Git executable path or command array.
 * @returns The normalized remote URL, or null if no remote is found.
 */
export async function getNormalizedRemoteUrl(git$: string | string[]): Promise<string | null> {
   const remoteName = await getDefaultRemoteName(git$);
   if (!remoteName) return null;

   try {
      const { stdout } = await $`${git$} remote get-url ${remoteName}`;
      const remoteUrl = stdout.trim();
      if (!remoteUrl) return null;
      const normalized = normalizeRemoteUrl(remoteUrl);
      return normalized || null;
   } catch {
      return null;
   }
}

/**
 * Gets the root directory of the main worktree, even when called from a linked worktree.
 * Uses git-common-dir to find the main repository location.
 * @param git$ - Git executable path or command array.
 * @returns The absolute path to the main worktree root directory.
 */
export async function getMainWorktreeRoot(git$: string | string[]): Promise<string> {
   let repoRoot = '';

   try {
      const { stdout } = await $`${git$} rev-parse --show-toplevel`;
      repoRoot = stdout.trim();
   } catch {
      repoRoot = process.cwd();
   }

   try {
      const { stdout } = await $`${git$} rev-parse --git-common-dir`;
      const commonDir = stdout.trim();
      if (!commonDir) return repoRoot;

      const commonDirAbs = path.isAbsolute(commonDir)
         ? commonDir
         : path.resolve(repoRoot, commonDir);
      const normalizedCommonDir = commonDirAbs.replace(/\\/g, '/');

      if (normalizedCommonDir.includes('/.git/worktrees/')) {
         const gitDir = path.dirname(path.dirname(commonDirAbs));
         const mainRoot = path.dirname(gitDir);
         return mainRoot || repoRoot;
      }

      try {
         const gitFile = fs.readFileSync(commonDirAbs, 'utf-8');
         const gitDirLine = gitFile
            .split('\n')
            .map((line) => line.trim())
            .find((line) => line.toLowerCase().startsWith('gitdir:'));

         if (gitDirLine) {
            const gitDirRaw = gitDirLine.split(':').slice(1).join(':').trim();
            const gitDirAbs = path.isAbsolute(gitDirRaw)
               ? gitDirRaw
               : path.resolve(repoRoot, gitDirRaw);
            const normalizedGitDir = gitDirAbs.replace(/\\/g, '/');

            if (normalizedGitDir.includes('/.git/worktrees/')) {
               const gitDir = path.dirname(path.dirname(gitDirAbs));
               const mainRoot = path.dirname(gitDir);
               return mainRoot || repoRoot;
            }
         }
      } catch {
         // ignore: commonDirAbs may be a directory, not a .git file
      }

      const mainRoot = path.dirname(commonDirAbs);
      return mainRoot || repoRoot;
   } catch {
      return repoRoot;
   }
}

/**
 * Checks if a cherry-pick operation is currently in progress.
 * @param git$ - Git executable path or command array.
 * @param originPath - The path to the Git repository.
 * @returns True if a cherry-pick is in progress, false otherwise.
 */
export async function hasCherryPickInProgress(
   git$: string | string[],
   originPath: string
): Promise<boolean> {
   try {
      await $`${git$} -C ${originPath} rev-parse -q --verify CHERRY_PICK_HEAD`;
      return true;
   } catch {
      return false;
   }
}

/**
 * Helper function to normalize a remote URL's host and path components.
 * Removes leading slashes/colons, .git suffix, and trailing slashes from the path.
 * @param host - The hostname (e.g., "github.com").
 * @param repoPath - The repository path portion of the URL.
 * @returns The normalized path in the format "host/path" or just "path" if host is empty.
 */
function normalizeRemoteHostPath(host: string, repoPath: string): string {
   let normalizedPath = repoPath.replace(/^[/:]+/, '');
   normalizedPath = normalizedPath.replace(/\.git$/i, '');
   normalizedPath = normalizedPath.replace(/\/+$/, '');
   if (host) return `${host}/${normalizedPath}`;
   return normalizedPath;
}
