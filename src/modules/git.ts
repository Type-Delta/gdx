import path from 'path';

import * as fs from '@/modules/fs';

import Logger from '../utils/logger';
import { yuString } from '@lib/Tools';
import { $ } from './shell';

export interface WorktreeEntry {
   path: string;
   locked: boolean;
   lockReason: string | null;
   prunable: boolean;
}

export interface SubmoduleEntry {
   path: string;
   status: string;
   initialized: boolean;
}

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
 * Normalizes a worktree path for reliable comparisons.
 * @param inputPath - The worktree path to normalize.
 * @returns A normalized path suitable for comparisons.
 */
export function normalizeWorktreePath(inputPath: string): string {
   const resolved = path.resolve(inputPath).replace(/\\/g, '/');
   return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Normalizes a status path from git porcelain output.
 * @param rawPath - The raw path value from git status.
 * @returns A normalized path suitable for comparisons.
 */
export function normalizeStatusPath(rawPath: string): string {
   const trimmed = rawPath.trim().replace(/^"|"$/g, '');
   return trimmed.replace(/\\/g, '/');
}

/**
 * Lists worktrees using porcelain format.
 * @param git$ - Git executable path or command array.
 * @returns A list of parsed worktree entries.
 */
export async function getWorktreeList(git$: string | string[]): Promise<WorktreeEntry[]> {
   try {
      const output = (await $`${git$} worktree list --porcelain`).stdout.trim();
      if (!output) return [];

      const entries: WorktreeEntry[] = [];
      let current: WorktreeEntry | null = null;

      for (const line of output.split('\n')) {
         if (!line.trim()) continue;

         if (line.startsWith('worktree ')) {
            if (current) entries.push(current);
            current = {
               path: line.slice('worktree '.length).trim(),
               locked: false,
               lockReason: null,
               prunable: false,
            };
            continue;
         }

         if (!current) continue;

         if (line.startsWith('locked')) {
            current.locked = true;
            const reason = line.slice('locked'.length).trim();
            current.lockReason = reason.length > 0 ? reason : null;
         } else if (line.startsWith('prunable')) {
            current.prunable = true;
         }
      }

      if (current) entries.push(current);
      return entries;
   } catch (err) {
      Logger.debug(yuString(err, { color: true }), 'git');
      return [];
   }
}

/**
 * Finds a worktree entry for a given path.
 * @param git$ - Git executable path or command array.
 * @param worktreePath - The worktree path to locate.
 * @returns The matching entry or null if not found.
 */
export async function getWorktreeEntry(
   git$: string | string[],
   worktreePath: string
): Promise<WorktreeEntry | null> {
   const entries = await getWorktreeList(git$);
   const target = normalizeWorktreePath(worktreePath);
   return entries.find((entry) => normalizeWorktreePath(entry.path) === target) ?? null;
}

/**
 * Prunes worktree metadata for missing directories.
 * @param git$ - Git executable path or command array.
 */
export async function pruneWorktrees(git$: string | string[]): Promise<void> {
   try {
      await $`${git$} worktree prune --expire now`;
   } catch (err) {
      Logger.debug(yuString(err, { color: true }), 'git');
   }
}

/**
 * Resolves a git path from a worktree directory.
 * @param git$ - Git executable path or command array.
 * @param worktreePath - The worktree root path.
 * @param gitPath - The git path to resolve.
 * @returns The resolved absolute path or null if unavailable.
 */
export async function getGitPath(
   git$: string | string[],
   worktreePath: string,
   gitPath: string
): Promise<string | null> {
   try {
      const output = (
         await $`${git$} -C ${worktreePath} rev-parse --git-path ${gitPath}`
      ).stdout.trim();
      if (!output) return null;
      return path.isAbsolute(output) ? output : path.resolve(worktreePath, output);
   } catch {
      return null;
   }
}

/**
 * Detects in-progress operations inside a worktree.
 * @param git$ - Git executable path or command array.
 * @param worktreePath - The worktree root path.
 * @returns A list of active operation labels.
 */
export async function getWorktreeOperations(
   git$: string | string[],
   worktreePath: string
): Promise<string[]> {
   const checks = [
      { label: 'merge', path: 'MERGE_HEAD' },
      { label: 'cherry-pick', path: 'CHERRY_PICK_HEAD' },
      { label: 'revert', path: 'REVERT_HEAD' },
      { label: 'rebase', path: 'rebase-apply' },
      { label: 'rebase', path: 'rebase-merge' },
      { label: 'bisect', path: 'BISECT_LOG' },
      { label: 'sequencer', path: 'sequencer' },
   ];

   const active = new Set<string>();
   for (const check of checks) {
      const resolvedPath = await getGitPath(git$, worktreePath, check.path);
      if (!resolvedPath) continue;
      if (fs.existsSync(resolvedPath)) active.add(check.label);
   }

   return Array.from(active);
}

/**
 * Collects submodule entries for a worktree.
 * @param git$ - Git executable path or command array.
 * @param worktreePath - The worktree root path.
 * @returns A list of submodule entries.
 */
export async function getSubmodules(
   git$: string | string[],
   worktreePath: string
): Promise<SubmoduleEntry[]> {
   try {
      let configOutput = '';
      try {
         configOutput = (
            await $`${git$} -C ${worktreePath} config --file .gitmodules --get-regexp path`
         ).stdout.trim();
      } catch {
         configOutput = '';
      }

      const configPaths = configOutput
         .split('\n')
         .map((line) => line.trim())
         .filter((line) => line.length > 0)
         .map((line) => {
            const match = line.match(/^submodule\.(.+?)\.path\s+(.+)$/);
            return match?.[2]?.trim() ?? '';
         })
         .filter((submodulePath) => submodulePath.length > 0);

      const gitmodulesPath = path.join(worktreePath, '.gitmodules');
      let filePaths: string[] = [];
      if (fs.existsSync(gitmodulesPath)) {
         try {
            const content = fs.readFileSync(gitmodulesPath, 'utf-8');
            filePaths = content
               .split('\n')
               .map((line) => line.trim())
               .map((line) => line.match(/^path\s*=\s*(.+)$/)?.[1]?.trim() ?? '')
               .filter((submodulePath) => submodulePath.length > 0);
         } catch {
            filePaths = [];
         }
      }

      let gitlinkPaths: string[] = [];
      try {
         const lsFilesOutput = (await $`${git$} -C ${worktreePath} ls-files --stage`).stdout;
         gitlinkPaths = lsFilesOutput
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.startsWith('160000 '))
            .map((line) => line.match(/^160000 [0-9a-f]{40} \d\t(.+)$/)?.[1]?.trim() ?? '')
            .filter((submodulePath) => submodulePath.length > 0);
      } catch {
         gitlinkPaths = [];
      }

      const configPathSet = new Set([...configPaths, ...filePaths, ...gitlinkPaths]);
      if (configPathSet.size === 0) return [];
      const resolvedPaths = Array.from(configPathSet);

      let statusMap = new Map<string, string>();
      try {
         const output = (await $`${git$} -C ${worktreePath} submodule status --recursive`).stdout;
         const lines = output
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0 && !line.startsWith('Entering '));

         for (const line of lines) {
            const status = line[0];
            const match = line.match(/^[ +-U]([0-9a-f]{7,40})\s+(.+?)(?:\s+\(|$)/);
            const submodulePath = match?.[2]?.trim();
            if (submodulePath) statusMap.set(submodulePath, status);
         }
      } catch {
         statusMap = new Map<string, string>();
      }

      return resolvedPaths.map((submodulePath) => {
         const status = statusMap.get(submodulePath) ?? '-';
         return {
            path: submodulePath,
            status,
            initialized: status !== '-',
         } satisfies SubmoduleEntry;
      });
   } catch (err) {
      Logger.debug(yuString(err, { color: true }), 'git');
      return [];
   }
}

/**
 * Finds submodules with local changes or inconsistent state.
 * @param git$ - Git executable path or command array.
 * @param worktreePath - The worktree root path.
 * @param submodules - The submodule entries to evaluate.
 * @returns A list of dirty submodule paths.
 */
export async function getDirtySubmodules(
   git$: string | string[],
   worktreePath: string,
   submodules: SubmoduleEntry[]
): Promise<string[]> {
   const dirty: string[] = [];

   for (const submodule of submodules) {
      if (submodule.status !== ' ' && submodule.status !== '-') {
         dirty.push(submodule.path);
         continue;
      }

      const submodulePath = path.resolve(worktreePath, submodule.path);
      if (!fs.existsSync(submodulePath)) continue;

      const gitMarker = path.join(submodulePath, '.git');
      if (!fs.existsSync(gitMarker)) {
         if (submodule.status !== '-') {
            try {
               const entries = fs.readdirSync(submodulePath);
               if (entries.length > 0) dirty.push(submodule.path);
            } catch {
               dirty.push(submodule.path);
            }
         }
         continue;
      }

      try {
         const status = (
            await $`${git$} -C ${submodulePath} status --porcelain=v1 --untracked-files=normal`
         ).stdout.trim();
         if (status.length > 0) dirty.push(submodule.path);
      } catch {
         dirty.push(submodule.path);
      }
   }

   return dirty;
}

/**
 * Deinitializes all submodules in a worktree.
 * @param git$ - Git executable path or command array.
 * @param worktreePath - The worktree root path.
 */
export async function deinitSubmodules(
   git$: string | string[],
   worktreePath: string
): Promise<void> {
   await $`${git$} -C ${worktreePath} submodule deinit -f --all`;
}

/**
 * Initializes all submodules in a worktree.
 * @param git$ - Git executable path or command array.
 * @param worktreePath - The worktree root path.
 */
export async function initSubmodules(git$: string | string[], worktreePath: string): Promise<void> {
   const submodules = await getSubmodules(git$, worktreePath);
   if (submodules.length === 0) return;
   await $`${git$} -c protocol.file.allow=always -C ${worktreePath} submodule update --init --recursive`;
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
