import { whichExec } from './shell';
import { getCache } from '@/common/cache';
import Logger from '@/utils/logger';
import * as fs from './fs';

type ValueResover<T> = () => T | Promise<T>;

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
      return cached;
   }

   try {
      const execPath = resolver ? await resolver() : await whichExec(cmd);
      if (!execPath) return null;

      await cache.set(cacheKey, execPath);
      return execPath;
   } catch (err) {
      Logger.warn(`Failed to get which exec for ${cmd}: ${err}`, 'cache-ctrl');
      throw err;
   }
}
