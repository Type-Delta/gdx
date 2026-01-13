import path from 'path';

import { $, whichExec } from './shell';
import { getCache } from '@/common/cache';
import Logger from '@/utils/logger';
import * as fs from './fs';

type ValueResover<T> = () => T | Promise<T>;

/**
 * Gets git version, cached for the session.
 * Cache key: 'git.version'
 * Expired after 1 day (configured in CACHE_MAX_AGE).
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
   const cacheKey = 'git.repoRoot';

   const cached = await cache.get<string>(cacheKey);
   if (cached) {
      const [lastDir, cacheDir] = cached.split(path.delimiter);

      if (
         cacheDir && // Make sure cache is valid (<lastRunDir>:<cacheDir>)
         path.resolve(cacheDir) === path.resolve(lastDir) && // Still in the same directory
         fs.existsSync(cacheDir) // Cache dir still exists
      ) {
         Logger.debug(`Cache hit for ${cacheKey}`, 'cache-ctrl');
         return cached;
      }
   }

   try {
      const { stdout } = await $`${git$} rev-parse --show-toplevel`;
      const repoRoot = stdout.trim();

      await cache.set(cacheKey, `${process.cwd()}${path.delimiter}${repoRoot}`);
      Logger.debug(`Cache store for ${cacheKey}: ${repoRoot}`, 'cache-ctrl');

      return repoRoot;
   } catch (err) {
      Logger.warn(`Failed to get repo root: ${err}`, 'cache-ctrl');
      throw err;
   }
}

/**
 * Gets current git branch name, cached for the session.
 * Cache key: 'git.branch'
 */
export async function getCurrentBranchCached(git$: string | string[]): Promise<string> {
   const cache = await getCache();
   const cacheKey = 'git.branch';

   const cached = await cache.get<string>(cacheKey);
   if (cached) {
      Logger.debug(`Cache hit for ${cacheKey}`, 'cache-ctrl');
      return cached;
   }

   try {
      const { stdout } = await $`${git$} rev-parse --abbrev-ref HEAD`;
      const branch = stdout.trim();

      await cache.set(cacheKey, branch);
      Logger.debug(`Cache store for ${cacheKey}: ${branch}`, 'cache-ctrl');

      return branch;
   } catch (err) {
      Logger.warn(`Failed to get current branch: ${err}`, 'cache-ctrl');
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
   if (cached !== undefined) {
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
