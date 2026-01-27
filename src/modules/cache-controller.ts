import crypto from 'crypto';

import { $, whichExec } from './shell';
import { getCache } from '@/common/cache';
import Logger from '@/utils/logger';
import * as fs from './fs';
import { Err } from '@lib/Tools';

type ValueResover<T> = () => T | Promise<T>;

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
   const cwdHash = crypto.createHash('sha1').update(cwd).digest('hex');
   const cacheKey = 'git.repoRoot.' + cwdHash;

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
 * Wrapper around whichExec with caching.
 * Cache key:
 * - 'which.<cmd>'
 *
 * @param cmd - The command to find.
 * @param resolver - Optional custom resolver function to find the command.
 * @returns The full path of the command, or null if not found.
 */
export async function getWhichExecCached(
   cmd: string,
   resolver?: ValueResover<string | null>
): Promise<string | null> {
   const cache = await getCache();
   const cacheKey = `which.${cmd}`;

   const cached = await cache.get<string | null>(cacheKey);
   if (cached != null && fs.existsSync(cached)) {
      Logger.debug(`Cache hit for ${cacheKey}`, 'cache-ctrl');
      return cached;
   }

   try {
      const execPath = resolver ? await resolver() : await whichExec(cmd);
      if (!execPath) return null;

      await cache.set(cacheKey, execPath);
      Logger.debug(`Cache store for ${cacheKey}: ${execPath}`, 'cache-ctrl');

      return execPath;
   } catch (err) {
      Logger.warn(`Failed to get which exec for ${cmd}: ${err}`, 'cache-ctrl');
      throw err;
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
 * Cache key: 'git.branches'
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
   const cacheKey = `git.branches${remote ? '.remote' : ''}`;

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
