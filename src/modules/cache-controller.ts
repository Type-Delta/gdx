import crypto from 'crypto';

import { whichExec } from './shell';
import { getCache } from '@/common/cache';
import Logger from '@/utils/logger';
import * as fs from './fs';

type ValueResover<T> = () => T | Promise<T>;

/**
 * Shape stored for a cached executable lookup.
 *
 * `env` pins the lookup to the environment that produced it. Entries written before this
 * field existed were bare strings, which no longer match and are re-resolved.
 */
interface CachedExecEntry {
   path: string;
   env: string;
}

/**
 * Fingerprints the environment that determines executable resolution.
 *
 * Resolving a command is a pure function of the search path, so the result is only reusable
 * while that path is unchanged. `PATHEXT` participates on Windows because it decides which
 * extensions are probed, and in which order.
 *
 * @returns A short digest of the resolution-relevant environment.
 */
function getExecLookupFingerprint(): string {
   const material = JSON.stringify([process.env.PATH ?? '', process.env.PATHEXT ?? '']);
   return crypto.createHash('sha1').update(material).digest('base64url').slice(0, 22);
}

/**
 * Wrapper around whichExec with caching.
 * Cache key:
 * - 'which.<cmd>'
 *
 * The cached path is only reused when it still exists **and** was resolved under the same
 * search path. Checking existence alone is not enough: every candidate stays on disk, so a
 * PATH change that should now resolve a different binary would otherwise be ignored
 * forever. On Windows this is routine — Git ships `git.exe` in `cmd\`, `bin\`, and
 * `mingw64\bin\`, and which one wins depends on the shell that launched the process.
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
   const fingerprint = getExecLookupFingerprint();

   const cached = await cache.get<CachedExecEntry | string | null>(cacheKey);
   if (
      cached != null &&
      typeof cached === 'object' &&
      cached.env === fingerprint &&
      fs.existsSync(cached.path)
   ) {
      return cached.path;
   }

   try {
      const execPath = resolver ? await resolver() : await whichExec(cmd);
      if (!execPath) return null;

      await cache.set(cacheKey, { path: execPath, env: fingerprint } satisfies CachedExecEntry);
      return execPath;
   } catch (err) {
      Logger.warn(`Failed to get which exec for ${cmd}: ${err}`, 'cache-ctrl');
      throw err;
   }
}
