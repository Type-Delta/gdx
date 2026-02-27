import crypto from 'crypto';
import path from 'path';

import { CheckCache, Err, yuString } from '@lib/Tools';

import { getCache } from '@/common/cache';
import * as fs from '@/modules/fs';
import { stripAnsiColor } from '@/modules/graphics';

import Logger from '../utils/logger';
import { $, $inherit, createAbortableExec } from './shell';
import { ArgsSet } from './arguments';
import { Result } from '@/common/types';

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
 * Result of commit log retrieval.
 * Includes the list of commits, total count, and more count.
 * @property commits - Array of commit SHAs.
 * @property totalCount - Total number of commits in the range.
 * @property moreCount - Number of additional commits beyond the retrieved ones.
 */
export interface CommitLogResult {
   commits: string[];
   totalCount: number;
   moreCount: number;
}

const GIT_HEAD_CACHE_TTL_MINUTES = 360;
const GIT_PATH_CACHE_TTL_MINUTES = 360;

function createCacheKey(prefix: string, scope: string): string {
   const hash = crypto.createHash('sha1').update(scope).digest('hex');
   return `${prefix}.${hash}`;
}

function getGitScope(git$: string | string[], worktreePath?: string): string {
   const gitKey = Array.isArray(git$) ? git$.join(' ') : git$;
   const basePath = worktreePath ? path.resolve(worktreePath) : process.cwd();
   return `${gitKey}|${basePath}`;
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
   const cache = await getCache();
   const cacheKey = createCacheKey('git.stashEntry', `${getGitScope(git$)}|${index}`);
   const cached = await cache.getOneOff<{ sha: string; message: string } | null>(cacheKey);
   if (cached !== undefined) return cached;

   try {
      const ref = `stash@{${index}}`;
      const { stdout: sha } = await $`${git$} rev-parse ${ref}`;
      const { stdout: message } = await $`${git$} log -1 --format=%s ${ref}`;
      const result = { sha: sha.trim(), message: message.trim() };
      await cache.setOneOff(cacheKey, result);
      return result;
   } catch {
      await cache.setOneOff(cacheKey, null);
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
   const cache = await getCache();
   const cacheKey = createCacheKey('git.defaultRemoteName', getGitScope(git$));
   const cached = await cache.getOneOff<string | null>(cacheKey);
   if (cached !== undefined) return cached;

   let result: string | null = null;
   try {
      const { stdout: remoteStdout } = await $`${git$} remote`;
      const remotes = remoteStdout
         .trim()
         .split('\n')
         .map((remote) => remote.trim())
         .filter(Boolean);

      if (remotes.length === 0) {
         result = null;
      } else {
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

         if (branchRemote && remotes.includes(branchRemote)) result = branchRemote;
         else if (remotes.includes('origin')) result = 'origin';
         else result = remotes[0];
      }
   } catch {
      result = null;
   }

   await cache.setOneOff(cacheKey, result);
   return result;
}

/**
 * Retrieves and normalizes the URL of the default remote.
 * Combines getDefaultRemoteName and normalizeRemoteUrl to get a standardized remote URL.
 * @param git$ - Git executable path or command array.
 * @returns The normalized remote URL, or null if no remote is found.
 */
export async function getNormalizedRemoteUrl(git$: string | string[]): Promise<string | null> {
   const cache = await getCache();
   const cacheKey = createCacheKey('git.normalizedRemoteUrl', getGitScope(git$));
   const cached = await cache.getOneOff<string | null>(cacheKey);
   if (cached !== undefined) return cached;

   const remoteName = await getDefaultRemoteName(git$);
   if (!remoteName) {
      await cache.setOneOff(cacheKey, null);
      return null;
   }

   try {
      const { stdout } = await $`${git$} remote get-url ${remoteName}`;
      const remoteUrl = stdout.trim();
      if (!remoteUrl) {
         await cache.setOneOff(cacheKey, null);
         return null;
      }
      const normalized = normalizeRemoteUrl(remoteUrl);
      const result = normalized || null;
      await cache.setOneOff(cacheKey, result);
      return result;
   } catch {
      await cache.setOneOff(cacheKey, null);
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
   const cache = await getCache();
   const cacheKey = createCacheKey('git.mainWorktreeRoot', getGitScope(git$));
   const cached = await cache.getOneOff<string>(cacheKey);
   if (cached !== undefined) return cached;

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
      if (!commonDir) {
         await cache.setOneOff(cacheKey, repoRoot);
         return repoRoot;
      }

      const commonDirAbs = path.isAbsolute(commonDir)
         ? commonDir
         : path.resolve(repoRoot, commonDir);
      const normalizedCommonDir = commonDirAbs.replace(/\\/g, '/');

      if (normalizedCommonDir.includes('/.git/worktrees/')) {
         const gitDir = path.dirname(path.dirname(commonDirAbs));
         const mainRoot = path.dirname(gitDir);
         const result = mainRoot || repoRoot;
         await cache.setOneOff(cacheKey, result);
         return result;
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
               const result = mainRoot || repoRoot;
               await cache.setOneOff(cacheKey, result);
               return result;
            }
         }
      } catch {
         // ignore: commonDirAbs may be a directory, not a .git file
      }

      const mainRoot = path.dirname(commonDirAbs);
      const result = mainRoot || repoRoot;
      await cache.setOneOff(cacheKey, result);
      return result;
   } catch {
      await cache.setOneOff(cacheKey, repoRoot);
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
   const cache = await getCache();
   const cacheKey = createCacheKey(
      'git.cherryPickInProgress',
      `${getGitScope(git$, originPath)}|${path.resolve(originPath)}`
   );
   const cached = await cache.getOneOff<boolean>(cacheKey);
   if (cached !== undefined) return cached;

   try {
      await $`${git$} -C ${originPath} rev-parse -q --verify CHERRY_PICK_HEAD`;
      await cache.setOneOff(cacheKey, true);
      return true;
   } catch {
      await cache.setOneOff(cacheKey, false);
      return false;
   }
}

/**
 * Gets git config value, cached for the session.
 * Cache key: 'git.config.<key>'
 *
 * @param git$ - Git executable reference.
 * @param configKey - The git config key (e.g., 'user.email', 'user.name').
 * @returns The git config value as a string, or empty string if not found.
 */
export async function getGitConfigCached(
   git$: string | string[],
   configKey: string
): Promise<string> {
   const cache = await getCache();
   const cacheKey = `git.config.${configKey}`;

   // Try to get from cache first
   const cached = await cache.get<string>(cacheKey);
   if (cached !== undefined) {
      Logger.debug(`Cache hit for ${cacheKey}`, 'cache-ctrl');
      return cached;
   }

   try {
      const { stdout } = await $`${git$} config ${configKey}`;
      const value = stdout.trim();

      // Only cache non-empty values
      if (value) {
         await cache.set(cacheKey, value);
         Logger.debug(`Cache store for ${cacheKey}: ${value}`, 'cache-ctrl');
      }

      return value;
   } catch (err) {
      // Don't cache failures - config might be set later
      Logger.warn(`Git config ${configKey} not found or failed`, 'cache-ctrl');
      Logger.debug(`Error details: ${Err.from(err)}`, 'cache-ctrl');
      return '';
   }
}

/**
 * Gets list of git branches, cached for the session.
 * Cache key: 'git.branches.<repo>'
 *
 * @param git$ - Git executable reference.
 * @param remote - If true, returns remote branches; otherwise local branches.
 * @returns Array of branch names.
 */
export async function getGitBranchesCached(
   git$: string | string[],
   remote: boolean = false
): Promise<string[]> {
   const cache = await getCache();
   const scope = `${getGitScope(git$)}|${remote ? 'remote' : 'local'}`;
   const cacheKey = createCacheKey('git.branches', scope);

   const cached = await cache.get<string[]>(cacheKey);
   if (cached) {
      Logger.debug(`Cache hit for ${cacheKey}`, 'cache-ctrl');
      return cached;
   }

   try {
      const args = remote
         ? ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/']
         : ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'];

      const { stdout } = await $`${git$} ${args}`;
      const branches = stdout
         .trim()
         .split('\n')
         .filter((b) => b.length > 0);

      await cache.set(cacheKey, branches);
      Logger.debug(`Cache store for ${cacheKey}: ${branches.length} branches`, 'cache-ctrl');

      return branches;
   } catch (err) {
      Logger.warn(`Failed to get git branches: ${Err.from(err)}`, 'cache-ctrl');
      return [];
   }
}

/**
 * Gets list of git tags, cached for the session.
 * Cache key: 'git.tags'
 *
 * @param git$ - Git executable reference.
 * @returns Array of tag names.
 */
export async function getGitTagsCached(git$: string | string[]): Promise<string[]> {
   const cache = await getCache();
   const cacheKey = 'git.tags';

   const cached = await cache.get<string[]>(cacheKey);
   if (cached) {
      Logger.debug(`Cache hit for ${cacheKey}`, 'cache-ctrl');
      return cached;
   }

   try {
      const { stdout } = await $`${git$} tag`;
      const tags = stdout
         .trim()
         .split('\n')
         .filter((t) => t.length > 0);

      await cache.set(cacheKey, tags);
      Logger.debug(`Cache store for ${cacheKey}: ${tags.length} tags`, 'cache-ctrl');

      return tags;
   } catch (err) {
      Logger.warn(`Failed to get git tags: ${err}`, 'cache-ctrl');
      return [];
   }
}

/**
 * Checks if a specific author exists in git history, cached for the session.
 * Cache key: 'git.author.<email>'
 *
 * @param git$ - Git executable reference.
 * @param email - The author email to check.
 * @returns True if the author exists, false otherwise.
 */
export async function getGitAuthorExistsCached(
   git$: string | string[],
   email: string
): Promise<boolean> {
   const cache = await getCache();
   const cacheKey = `git.author.${email}`;

   const cached = await cache.get<boolean>(cacheKey);
   if (cached !== undefined) {
      Logger.debug(`Cache hit for ${cacheKey}`, 'cache-ctrl');
      return cached;
   }

   try {
      const { stdout } = await $`${git$} rev-list --all --author=${email} --pretty=format:%an`;
      const exists = stdout.trim().length > 0;

      await cache.set(cacheKey, exists);
      Logger.debug(`Cache store for ${cacheKey}: ${exists}`, 'cache-ctrl');

      return exists;
   } catch (err) {
      Logger.warn(`Failed to check if author exists: ${Err.from(err)}`, 'cache-ctrl');
      return false;
   }
}

/**
 * Resolves the tracked upstream ref for the current branch.
 * @param git$ - Git executable path or command array.
 * @returns The upstream ref (e.g., origin/main) or null if none is configured.
 */
export async function getTrackedUpstreamRef(git$: string | string[]): Promise<string | null> {
   const cache = await getCache();
   const cacheKey = createCacheKey('git.trackedUpstreamRef', getGitScope(git$));
   const cached = await cache.getOneOff<string | null>(cacheKey);

   if (cached !== undefined) return cached;

   const exec = createAbortableExec();
   try {
      const { stdout } = await exec.$`${git$} rev-parse --abbrev-ref --symbolic-full-name @{u}`;
      const upstream = stdout.trim();
      await cache.setOneOff(cacheKey, upstream);
      return upstream || null;
   } catch {
      return null;
   }
}

/**
 * Gets git version, cached for the session.
 * Cache key: 'git.version'
 */
export async function getGitVersionCached(git$: string | string[]): Promise<string> {
   const cache = await getCache();
   const cacheKey = 'git.version';

   // Try to get from cache first
   const cached = await cache.get<string>(cacheKey);
   if (cached) {
      Logger.debug(`Cache hit for ${cacheKey}`, 'cache-ctrl');
      return cached;
   }

   // Cache miss: fetch from git
   try {
      const { stdout } = await $`${git$} --version`;
      const version = stdout.trim().match(/(\d{1,2}\.\d{1,3}\.\d{1,3})/i)?.[1] || 'unknown';

      // Store in cache for future use
      await cache.set(cacheKey, version);
      Logger.debug(`Cache store for ${cacheKey}: ${version}`, 'cache-ctrl');

      return version;
   } catch (err) {
      Logger.warn(`Failed to get git version: ${err}`, 'cache-ctrl');
      throw err;
   }
}

/**
 * Gets git repository root, cached for the session.
 * Cache key: 'git.repoRoot'
 */
export async function getRepoRootCached(git$: string | string[]): Promise<string> {
   const cache = await getCache();
   const cwd = process.cwd();
   const gitKey = Array.isArray(git$) ? git$.join(' ') : git$;
   const scopeHash = crypto.createHash('sha1').update(`${gitKey}|${cwd}`).digest('hex');
   const cacheKey = 'git.repoRoot.' + scopeHash;

   const cachedDir = await cache.get<string>(cacheKey);
   if (
      cachedDir &&
      fs.existsSync(cachedDir) // Cache dir still exists
   ) {
      Logger.debug(`Cache hit for ${cacheKey}`, 'cache-ctrl');
      return cachedDir;
   }

   try {
      const { stdout } = await $`${git$} rev-parse --show-toplevel`;
      const repoRoot = stdout.trim();

      await cache.set(cacheKey, repoRoot);
      Logger.debug(`Cache store for ${cacheKey}: ${repoRoot}`, 'cache-ctrl');

      return repoRoot;
   } catch (err) {
      Logger.warn(`Failed to get repo root: ${err}`, 'cache-ctrl');
      throw err;
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
   const cache = await getCache();
   const cacheKey = createCacheKey('git.worktreeList', getGitScope(git$));
   const cached = await cache.getOneOff<WorktreeEntry[]>(cacheKey);
   if (cached !== undefined) return cached;

   try {
      const output = (await $`${git$} worktree list --porcelain`).stdout.trim();
      if (!output) {
         await cache.setOneOff(cacheKey, []);
         return [];
      }

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
      await cache.setOneOff(cacheKey, entries);
      return entries;
   } catch (err) {
      Logger.debug(yuString(err, { color: true }), 'git');
      await cache.setOneOff(cacheKey, []);
      return [];
   }
}

/**
 * Clears the cached worktree list for the current repository scope.
 * Useful after worktree add/remove operations.
 * @param git$ - Git executable path or command array.
 */
export async function invalidateWorktreeListCache(git$: string | string[]): Promise<void> {
   const cache = await getCache();
   const cacheKey = createCacheKey('git.worktreeList', getGitScope(git$));
   await cache.deleteOneOff(cacheKey);
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
   } finally {
      await invalidateWorktreeListCache(git$);
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
   const cache = await getCache();
   const scope = `${getGitScope(git$, worktreePath)}|${gitPath}`;
   const cacheKey = createCacheKey('git.path', scope);
   const cached = await cache.get<string | null>(cacheKey);
   if (cached !== undefined) return cached;

   try {
      const output = (
         await $`${git$} -C ${worktreePath} rev-parse --git-path ${gitPath}`
      ).stdout.trim();
      if (!output) {
         await cache.set(cacheKey, null, { maxAgeMinutes: GIT_PATH_CACHE_TTL_MINUTES });
         return null;
      }
      const resolved = path.isAbsolute(output) ? output : path.resolve(worktreePath, output);
      await cache.set(cacheKey, resolved, { maxAgeMinutes: GIT_PATH_CACHE_TTL_MINUTES });
      return resolved;
   } catch (err) {
      Logger.debug(yuString(err, { color: true }), 'git');
      await cache.set(cacheKey, null, { maxAgeMinutes: GIT_PATH_CACHE_TTL_MINUTES });
      return null;
   }
}

async function getHeadSignature(gitExec: string, repoPath: string): Promise<string | null> {
   const headPath = await getGitPath(gitExec, repoPath, 'HEAD');
   if (!headPath) return null;

   const headMtime = await fs.getStatMTime(headPath);
   let refMtime: number | undefined;
   let refPath = '';

   try {
      const content = fs.readFileSync(headPath, 'utf-8').trim();
      const match = content.match(/^ref:\s*(.+)$/i);
      if (match?.[1]) {
         refPath = match[1].trim();
         if (refPath) {
            const resolvedRef = await getGitPath(gitExec, repoPath, refPath);
            refMtime = await fs.getStatMTime(resolvedRef);
         }
      }
   } catch {
      // ignore signature enrichment errors
   }

   return `${headMtime ?? 'null'}|${refPath}|${refMtime ?? 'null'}`;
}

/**
 * Gets a rev-parse value cached on disk.
 * @param gitExec - Git executable path.
 * @param repoPath - Repository path.
 * @param ref - Ref to resolve.
 * @returns The resolved SHA/ref string, or empty string on failure.
 */
export async function getRevParseCached(
   gitExec: string,
   repoPath: string,
   ref: string | string[]
): Promise<string> {
   const cache = await getCache();
   const refArgs = Array.isArray(ref) ? ref : ref.trim().split(/\s+/).filter(Boolean);
   const refKey = refArgs.join(' ');
   const scope = `${gitExec}|${path.resolve(repoPath)}|${refKey}`;
   const cacheKey = createCacheKey('git.revParse', scope);
   const isHeadRef =
      (refArgs.length === 1 && refArgs[0] === 'HEAD') ||
      (refArgs.length === 2 && refArgs[0] === '--abbrev-ref' && refArgs[1] === 'HEAD');
   const headSignature = isHeadRef ? await getHeadSignature(gitExec, repoPath) : null;
   if (isHeadRef && headSignature !== null) {
      const cached = await cache.get<{ value: string; signature: string | null }>(cacheKey);
      if (cached && cached.signature === headSignature) return cached.value;
   } else {
      const cached = await cache.get<string>(cacheKey);
      if (cached !== undefined) return cached;
   }

   try {
      const args = ['-C', repoPath, 'rev-parse', ...refArgs];
      const output = (await $`${gitExec} ${args}`).stdout.trim();
      if (isHeadRef && headSignature !== null) {
         await cache.set(
            cacheKey,
            { value: output, signature: headSignature },
            {
               maxAgeMinutes: GIT_HEAD_CACHE_TTL_MINUTES,
            }
         );
      } else {
         await cache.set(cacheKey, output, { maxAgeMinutes: GIT_HEAD_CACHE_TTL_MINUTES });
      }
      return output;
   } catch {
      if (isHeadRef && headSignature !== null) {
         await cache.set(
            cacheKey,
            { value: '', signature: headSignature },
            {
               maxAgeMinutes: GIT_HEAD_CACHE_TTL_MINUTES,
            }
         );
      } else {
         await cache.set(cacheKey, '', { maxAgeMinutes: GIT_HEAD_CACHE_TTL_MINUTES });
      }
      return '';
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
   const gitExec = Array.isArray(git$) ? git$[0] : git$;
   const cache = await getCache();
   const scope = getGitScope(git$, worktreePath);
   const pathsCacheKey = createCacheKey('git.submodules.paths', scope);
   const gitlinksCacheKey = createCacheKey('git.submodules.gitlinks', scope);
   const gitmodulesPath = path.join(worktreePath, '.gitmodules');
   const gitmodulesMtime = (await fs.getStatMTime(gitmodulesPath)) ?? null;
   let indexMtime: number | null = null;
   const cachedGitlinks = await cache.get<{ mtime: number | null; paths: string[] }>(
      gitlinksCacheKey
   );

   try {
      let configPaths: string[] = [];
      const cachedPaths = await cache.get<{ mtime: number | null; paths: string[] }>(pathsCacheKey);
      if (cachedPaths && cachedPaths.mtime === gitmodulesMtime) {
         configPaths = cachedPaths.paths;
      } else if (gitmodulesMtime !== null) {
         try {
            const configOutput = (
               await $`${gitExec} -C ${worktreePath} config --file .gitmodules --get-regexp path`
            ).stdout.trim();
            configPaths = configOutput
               .split('\n')
               .map((line) => line.trim())
               .filter((line) => line.length > 0)
               .map((line) => {
                  const match = line.match(/^submodule\.(.+?)\.path\s+(.+)$/);
                  return match?.[2]?.trim() ?? '';
               })
               .filter((submodulePath) => submodulePath.length > 0);
         } catch {
            configPaths = [];
         }
         await cache.set(pathsCacheKey, { mtime: gitmodulesMtime, paths: configPaths });
      } else if (cachedPaths && cachedPaths.mtime === null) {
         configPaths = cachedPaths.paths;
      }

      let gitlinkPaths: string[] = [];
      let gitlinkInfo = new Map<string, { sha: string; stage: string }>();
      if (indexMtime === null) {
         indexMtime =
            (await fs.getStatMTime(await getGitPath(git$, worktreePath, 'index'))) ?? null;
      }
      if (cachedGitlinks && cachedGitlinks.mtime === indexMtime && indexMtime !== null) {
         gitlinkPaths = cachedGitlinks.paths;
      } else {
         try {
            const lsFilesOutput = (await $`${gitExec} -C ${worktreePath} ls-files --stage`).stdout;
            const gitlinkEntries = lsFilesOutput
               .split('\n')
               .map((line) => line.trim())
               .filter((line) => line.startsWith('160000 '))
               .map((line) => {
                  const match = line.match(/^160000 ([0-9a-f]{40}) (\d)\t(.+)$/);
                  return match ? { sha: match[1], stage: match[2], path: match[3].trim() } : null;
               })
               .filter((entry): entry is { sha: string; stage: string; path: string } => !!entry)
               .filter((entry) => entry.path.length > 0);

            gitlinkInfo = new Map(
               gitlinkEntries.map((entry) => [entry.path, { sha: entry.sha, stage: entry.stage }])
            );
            gitlinkPaths = Array.from(gitlinkInfo.keys());
         } catch {
            gitlinkPaths = [];
         }
         await cache.set(gitlinksCacheKey, { mtime: indexMtime, paths: gitlinkPaths });
      }

      const configPathSet = new Set([...configPaths, ...gitlinkPaths]);
      if (configPathSet.size === 0) return [];
      const resolvedPaths = Array.from(configPathSet);

      const statusList = await Promise.all(
         resolvedPaths.map(async (submodulePath) => {
            const info = gitlinkInfo.get(submodulePath);
            if (info && info.stage !== '0') return { path: submodulePath, status: 'U' };

            const submoduleRepoPath = path.resolve(worktreePath, submodulePath);
            const gitMarker = path.join(submoduleRepoPath, '.git');
            if (!fs.existsSync(submoduleRepoPath) || !fs.existsSync(gitMarker)) {
               return { path: submodulePath, status: '-' };
            }

            if (!info?.sha) {
               return { path: submodulePath, status: ' ' };
            }

            const headSha = (await getRevParseCached(gitExec, submoduleRepoPath, 'HEAD')).trim();
            const status = headSha && headSha !== info.sha ? '+' : ' ';
            return { path: submodulePath, status };
         })
      );

      return statusList.map((entry) => {
         return {
            path: entry.path,
            status: entry.status,
            initialized: entry.status !== '-',
         } satisfies SubmoduleEntry;
      });
   } catch (err) {
      Logger.debug(yuString(err, { color: true }), 'git');
      return [];
   }
}

export async function invalidateSubmodulesCache(
   git$: string | string[],
   worktreePath: string
): Promise<void> {
   const cache = await getCache();
   const scope = getGitScope(git$, worktreePath);
   await cache.delete(createCacheKey('git.submodules.paths', scope));
   await cache.delete(createCacheKey('git.submodules.gitlinks', scope));
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
   const gitExec = Array.isArray(git$) ? git$[0] : git$;
   const dirty: string[] = [];

   for (const submodule of submodules) {
      if (submodule.status === 'U') {
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
            await $`${gitExec} -C ${submodulePath} status --porcelain=v1 --untracked-files=normal`
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
   const gitExec = Array.isArray(git$) ? git$[0] : git$;
   await $`${gitExec} -C ${worktreePath} submodule deinit -f --all`;

   await invalidateSubmodulesCache(git$, worktreePath);
   const submodules = await getSubmodules(git$, worktreePath);
   if (submodules.length === 0) return;

   for (const submodule of submodules) {
      const submodulePath = path.resolve(worktreePath, submodule.path);
      try {
         if (fs.existsSync(submodulePath)) {
            fs.rmSync(submodulePath, { recursive: true, force: true });
         }
         fs.mkdirSync(submodulePath, { recursive: true });
      } catch (err) {
         Logger.debug(
            `Failed to clean submodule path '${submodulePath}'. ${yuString(err, { color: true })}`,
            'git'
         );
      }
   }

   try {
      const gitDirRaw = (await $`${gitExec} -C ${worktreePath} rev-parse --git-dir`).stdout.trim();
      if (gitDirRaw) {
         const gitDir = path.isAbsolute(gitDirRaw)
            ? gitDirRaw
            : path.resolve(worktreePath, gitDirRaw);
         const normalizedGitDir = gitDir.replace(/\\/g, '/');
         if (normalizedGitDir.includes('/.git/worktrees/')) {
            const modulesPath = path.join(gitDir, 'modules');
            if (fs.existsSync(modulesPath)) {
               fs.rmSync(modulesPath, { recursive: true, force: true });
            }
         }
      }
   } catch (err) {
      Logger.debug(
         `Failed to clean worktree submodule metadata. ${yuString(err, { color: true })}`,
         'git'
      );
   }
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
   await invalidateSubmodulesCache(git$, worktreePath);
}

/**
 * Determines if an error is due to an empty cherry-pick.
 *
 * This function accepts either an ExecaError or a raw error/string output.
 *
 * @param err - The error to evaluate.
 * @returns True if the error indicates an empty cherry-pick, false otherwise.
 */
export function isEmptyCherryPickError(err: unknown): boolean {
   const message = normalizeGitErrorText(err);
   if (!message) return false;
   return (
      message.includes('the previous cherry-pick is now empty') ||
      message.includes('the previous cherry-pick is empty') ||
      message.includes('previous cherry-pick is now empty') ||
      message.includes('previous cherry-pick is empty') ||
      message.includes('cherry-pick is now empty') ||
      message.includes('cherry-pick is empty') ||
      message.includes('the patch is empty') ||
      message.includes('patch is empty')
   );
}

function normalizeGitErrorText(err: unknown): string {
   if (!err) return '';
   if (typeof err === 'string') return stripAnsiColor(err).toLowerCase();
   const typedErr = err as { stdout?: unknown; stderr?: unknown; message?: unknown } | null;
   const parts = [typedErr?.stderr, typedErr?.stdout, typedErr?.message]
      .map((part) => formatGitOutput(part))
      .filter((part) => part.length > 0);
   if (parts.length === 0) return '';
   const combined = parts.join('\n');
   return stripAnsiColor(combined).toLowerCase();
}

function formatGitOutput(output: unknown): string {
   if (!output) return '';
   if (typeof output === 'string') return output;
   if (output instanceof Uint8Array) return new TextDecoder().decode(output);
   return String(output);
}

/**
 * Gets the list of unmerged file paths in the repository.
 * @param git$ - Git executable path or command array.
 * @param originPath - The path to the Git repository.
 * @returns An array of unmerged file paths.
 */
export async function getUnmergedPaths(
   git$: string | string[],
   originPath: string
): Promise<string[]> {
   try {
      const output = (await $`${git$} -C ${originPath} diff --name-only --diff-filter=U`).stdout;
      return output
         .split('\n')
         .map((line) => line.trim())
         .filter((line) => line.length > 0);
   } catch {
      return [];
   }
}

/**
 * Stages all resolved conflicts in the repository.
 * @param git$ - Git executable path or command array.
 * @param originPath - The path to the Git repository.
 */
export async function stageResolvedConflicts(
   git$: string | string[],
   originPath: string
): Promise<void> {
   const unmergedPaths = await getUnmergedPaths(git$, originPath);
   if (unmergedPaths.length === 0) return;

   await $inherit`${git$} -C ${originPath} add -A -- ${unmergedPaths}`;
}

/**
 * Determines if the current cherry-pick operation is empty (no changes to commit).
 * @param git$ - Git executable path or command array.
 * @param originPath - The path to the Git repository.
 * @returns True if the cherry-pick is empty, false otherwise.
 */
export async function isCherryPickEmpty(
   git$: string | string[],
   originPath: string
): Promise<boolean> {
   const unmergedPaths = await getUnmergedPaths(git$, originPath);
   if (unmergedPaths.length > 0) return false;

   try {
      const staged = (await $`${git$} -C ${originPath} diff --cached --name-only`).stdout.trim();
      if (staged.length > 0) return false;
   } catch {
      return false;
   }

   return true;
}

/**
 * Gets commit log entries for a specified range.
 * @param options - The options for retrieving the commit log.
 * @param options.gitExec - The git executable path.
 * @param options.repoPath - The path to the Git repository.
 * @param options.range - The commit range (e.g., "HEAD~5..HEAD").
 * @param options.maxCount - Optional maximum number of commits to retrieve.
 * @param options.format - Optional git log format string. [IMPORTANT: Must not contain newlines]
 * @param options.excludeRefs - Optional refs to exclude from the range (e.g. origin HEAD)
 * @returns An object containing the commit log entries and counts.
 */
export async function getCommitRangeLog(options: {
   gitExec: string;
   repoPath: string;
   range: string;
   maxCount?: number;
   formatTemplate?: string;
   excludeRefs?: string[];
}): Promise<CommitLogResult> {
   const { gitExec, repoPath, range, maxCount, formatTemplate: format, excludeRefs } = options;
   let logOutput = '';
   try {
      const logArgs = ['-C', repoPath, 'log', `--pretty=format:${format || '%h %s'}`, range];
      const excludes = excludeRefs?.filter((ref) => ref && ref.trim().length > 0) ?? [];
      if (excludes.length > 0) {
         logArgs.push('--not', ...excludes);
      }
      logOutput = (await $`${gitExec} ${logArgs}`).stdout.trim();
   } catch {
      logOutput = '';
   }

   const allCommits = logOutput
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
   const totalCount = allCommits.length;
   if (totalCount === 0) return { commits: [], totalCount: 0, moreCount: 0 };

   const commits = maxCount && maxCount > 0 ? allCommits.slice(0, maxCount) : allCommits;
   const moreCount = Math.max(totalCount - commits.length, 0);
   return { commits, totalCount, moreCount };
}

/**
 * Gets the base SHA of a submodule at a specific commit in the parent repository.
 * @param gitExec - The git executable path.
 * @param worktreePath - The path to the parent repository worktree.
 * @param baseCommit - The commit SHA in the parent repository.
 * @param submodulePath - The path to the submodule within the parent repository.
 * @returns The submodule's base SHA or null if not found.
 */
export async function getSubmoduleBaseSha(
   gitExec: string,
   worktreePath: string,
   baseCommit: string,
   submodulePath: string
): Promise<string | null> {
   const cache = await getCache();
   const scope = `${gitExec}|${path.resolve(worktreePath)}|${baseCommit}|${submodulePath}`;
   const cacheKey = createCacheKey('git.submoduleBaseSha', scope);
   const cached = await cache.get<string | null>(cacheKey);
   if (cached !== undefined) return cached;

   try {
      const output = (
         await $`${gitExec} -C ${worktreePath} ls-tree ${baseCommit} -- ${submodulePath}`
      ).stdout.trim();
      if (!output) {
         await cache.set(cacheKey, null);
         return null;
      }
      const match = output.match(/^160000\s+commit\s+([0-9a-f]{7,40})\s+/i);
      const result = match?.[1] ?? null;
      await cache.set(cacheKey, result);
      return result;
   } catch {
      await cache.set(cacheKey, null);
      return null;
   }
}

/**
 * returns git's `color.ui=always` options of the host's terminal supports it.
 */
export function forceColorArgs(): string[] {
   if (CheckCache.supportsColor <= 0) return [];
   return ['-c', 'color.ui=always'];
}

/**
 * Expands relative ref notations in the provided arguments array.
 * Supports \~N and origin\~N formats, resolving them to absolute refs.
 *
 * For example, "HEAD~3" would be expanded to the commit SHA 3 ancestors before HEAD, and "origin~2" would resolve the upstream branch and then find the commit 2 ancestors before it.
 *
 * @param args - The array of arguments to process and expand.
 * @param git$ - Git executable reference, used for resolving upstream refs.
 * @param startIdx - The index in the args array to start processing from (default is 0).
 * @returns A Result indicating success or containing an error if expansion fails.
 */
export async function expandRelativeRef(
   args: ArgsSet,
   git$: string | string[],
   startIdx: number = 0
): Promise<Result<void>> {
   for (let i = startIdx; i < args.length; i++) {
      const match = /^(head|origin)?~(\d+)?$/i.exec(args[i]);
      if (!match) continue;

      let relativeIdx = 0;
      if (match[2]) {
         relativeIdx = parseInt(match[2], 10);
         if (isNaN(relativeIdx) || relativeIdx < 0) {
            Logger.error(`Invalid relative ref format: ${args[i]}`, 'reset');
            return { error: new Err(`Invalid relative ref format: ${args[i]}`) };
         }
      }

      try {
         if (match[1]?.toLowerCase() === 'origin') {
            const upstream = await getTrackedUpstreamRef(git$);
            if (!upstream) {
               Logger.error('No upstream configured for current branch.', 'reset');
               return { error: new Err('No upstream configured for current branch.') };
            }
            args[i] = `${upstream}~${relativeIdx}`;
            break;
         } else {
            args[i] = `HEAD~${relativeIdx}`;
         }
      } catch (err) {
         Logger.error(`Failed to expand relative ref: ${Err.from(err)}`, 'reset');
         return { error: Err.from(err) };
      }
   }
   return { value: undefined };
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
