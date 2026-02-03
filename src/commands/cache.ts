import path from 'path';

import { Err, ncc, strWrap, yuString } from '@lib/Tools';

import { resetCache } from '@/common/cache';
import { getConfig } from '@/common/config';
import { CommandHelpObj, CommandStructure, GdxContext } from '@/common/types';
import { CACHE_PATH, COLOR, EXECUTABLE_NAME, VERSION } from '@/consts';
import global from '@/global';
import { _2PointGradient } from '@/modules/graphics';
import * as fs from '@/modules/fs';
import Logger from '@/utils/logger';
import { quickPrint } from '@/utils/utilities';

interface CacheMetadata {
   version: string;
   createdAt: number;
   updatedAt: number;
   lastPruneAt: number;
}

interface CacheEntryMetadata {
   createdAt: number;
   updatedAt: number;
   expiresAt: number;
}

interface CacheStructure {
   meta: CacheMetadata;
   data: Record<string, unknown>;
   entryMeta: Record<string, CacheEntryMetadata>;
}

export default async function cache(ctx: GdxContext): Promise<number> {
   const subcommand = ctx.args[1];

   switch (subcommand) {
      case 'prune':
         return await pruneCache();
      case 'reset':
         return await resetCacheFile();
      case 'delete':
         return await expireCacheKeys(ctx.args.slice(2));
      case 'disable':
         return await setCacheEnabled(false);
      case 'enable':
         return await setCacheEnabled(true);
      default:
         quickPrint(help.usage());
         return 0;
   }
}

async function pruneCache(): Promise<number> {
   let cacheData: CacheStructure | null = null;
   try {
      cacheData = await loadCacheFile();
   } catch (err) {
      Logger.error(yuString(err, { color: true }), 'cache');
      return 1;
   }

   if (!cacheData) {
      quickPrint(`${ncc('Yellow')}No cache file found. Nothing to prune.${ncc()}`);
      return 0;
   }

   const now = Date.now();
   const expiredKeys = Object.entries(cacheData.entryMeta)
      .filter(([, meta]) => now > meta.expiresAt)
      .map(([key]) => key);

   let prunedCount = 0;
   for (const keyPath of expiredKeys) {
      const deleted = deleteCachePath(cacheData, keyPath);
      if (deleted) prunedCount++;
   }

   cacheData.meta.lastPruneAt = now;
   if (prunedCount > 0) {
      cacheData.meta.updatedAt = now;
   }

   await writeCacheFile(cacheData);
   resetCache();

   if (prunedCount > 0) {
      quickPrint(`${ncc('Green')}Pruned ${prunedCount} expired cache entries.${ncc()}`);
   } else {
      quickPrint(`${ncc('Cyan')}No expired cache entries found.${ncc()}`);
   }

   return 0;
}

async function resetCacheFile(): Promise<number> {
   try {
      const existsBefore = fs.existsSync(CACHE_PATH);
      await fs.rm(CACHE_PATH, { force: true, recursive: true });
      resetCache();

      if (!existsBefore) {
         quickPrint(`${ncc('Yellow')}No cache file found. Nothing to delete.${ncc()}`);
         return 0;
      }

      const message = fs.existsSync(CACHE_PATH)
         ? `${ncc('Yellow')}Cache file not removed: ${CACHE_PATH}${ncc()}`
         : `${ncc('Green')}Cache file deleted: ${CACHE_PATH}${ncc()}`;
      quickPrint(message);
      return 0;
   } catch (err) {
      Logger.error(yuString(err, { color: true }), 'cache');
      return 1;
   }
}

async function expireCacheKeys(rawKeys: string[]): Promise<number> {
   if (rawKeys.length === 0) {
      Logger.error('Usage: gdx cache delete <key|prefix> [more...]', 'cache');
      return 1;
   }

   let cacheData: CacheStructure | null = null;
   try {
      cacheData = await loadCacheFile();
   } catch (err) {
      Logger.error(yuString(err, { color: true }), 'cache');
      return 1;
   }

   if (!cacheData) {
      quickPrint(`${ncc('Yellow')}No cache file found. Nothing to delete.${ncc()}`);
      return 0;
   }

   const allKeys = Object.keys(cacheData.entryMeta);
   const matchedKeys = new Set<string>();

   for (const rawKey of rawKeys) {
      const trimmed = rawKey.trim();
      if (!trimmed) continue;

      const prefix = trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
      const prefixMatch = prefix.length > 0 ? `${prefix}.` : '';

      for (const key of allKeys) {
         if (key === prefix || (prefixMatch && key.startsWith(prefixMatch))) {
            matchedKeys.add(key);
         }
      }
   }

   if (matchedKeys.size === 0) {
      quickPrint(`${ncc('Yellow')}No matching cache keys found.${ncc()}`);
      return 0;
   }

   const now = Date.now();
   let expiredCount = 0;
   for (const key of matchedKeys) {
      const entry = cacheData.entryMeta[key];
      if (!entry) continue;
      entry.expiresAt = now - 1;
      entry.updatedAt = now;
      expiredCount++;
   }

   if (expiredCount > 0) {
      cacheData.meta.updatedAt = now;
      await writeCacheFile(cacheData);
      resetCache();
      quickPrint(`${ncc('Green')}Marked ${expiredCount} cache entries as expired.${ncc()}`);
      return 0;
   }

   quickPrint(`${ncc('Yellow')}No matching cache keys found.${ncc()}`);
   return 0;
}

async function setCacheEnabled(enabled: boolean): Promise<number> {
   const config = await getConfig();
   await config.set('cache.enabled', enabled);
   await config.save();

   const state = enabled ? 'enabled' : 'disabled';
   quickPrint(`${ncc('Green')}Cache ${state}.${ncc()}`);
   return 0;
}

async function loadCacheFile(): Promise<CacheStructure | null> {
   try {
      const content = await fs.readFile(CACHE_PATH, 'utf-8');
      const parsed = JSON.parse(content) as CacheStructure;

      if (!parsed || !parsed.meta || !parsed.data || !parsed.entryMeta) {
         throw new Err(
            'Cache file is invalid or corrupted. Run `gdx cache reset`.',
            'CACHE_INVALID'
         );
      }

      if (parsed.meta.version !== VERSION) {
         throw new Err(
            `Cache version mismatch (found ${parsed.meta.version}, expected ${VERSION}). Run gdx cache reset.`,
            'CACHE_VERSION_MISMATCH'
         );
      }

      if (!parsed.meta.lastPruneAt) {
         parsed.meta.lastPruneAt = parsed.meta.updatedAt || Date.now();
      }

      return parsed;
   } catch (err) {
      const error = Err.from(err);
      if (error.code === 'ENOENT') {
         return null;
      }
      throw err;
   }
}

async function writeCacheFile(cache: CacheStructure): Promise<void> {
   const dirPath = path.dirname(CACHE_PATH);
   fs.mkdirSync(dirPath, { recursive: true });
   await fs.writeFile(CACHE_PATH, JSON.stringify(cache), 'utf-8');
}

function deleteCachePath(cache: CacheStructure, keyPath: string): boolean {
   if (!cache.entryMeta[keyPath]) return false;

   delete cache.entryMeta[keyPath];

   const keys = keyPath.split('.');
   const pathToDelete: Array<{ obj: Record<string, unknown>; key: string }> = [];
   let current: any = cache.data;

   for (const key of keys) {
      if (current && typeof current === 'object' && key in current) {
         pathToDelete.push({ obj: current, key });
         current = current[key];
      } else {
         return false;
      }
   }

   if (pathToDelete.length > 0) {
      const last = pathToDelete[pathToDelete.length - 1];
      delete last.obj[last.key];
   }

   for (let i = pathToDelete.length - 2; i >= 0; i--) {
      const { obj, key } = pathToDelete[i];
      const child = obj[key];
      if (child && typeof child === 'object' && Object.keys(child).length === 0) {
         delete obj[key];
      } else {
         break;
      }
   }

   return true;
}

export const help = {
   long: () =>
      strWrap(
         `
${ncc('Bright') + _2PointGradient('CACHE', COLOR.Zinc400, COLOR.Zinc100, 0.2)}
Manually manage gdx cache entries and settings.

${ncc('Bright') + _2PointGradient('COMMANDS', COLOR.Zinc400, COLOR.Zinc100, 0.2)}
- prune: Remove expired entries from the cache file.
- reset: Delete the entire cache file.
- delete: Mark cache entries as expired by key or prefix.
- enable/disable: Toggle cache.enabled in gdx config.
`,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            mode: 'softboundary',
            indent: '  ',
         }
      ),
   short: 'Manually manage gdx cache entries and settings.',
   usage: () =>
      strWrap(
         `
${ncc('Cyan')}${EXECUTABLE_NAME} cache prune${ncc()}
${ncc('Cyan')}${EXECUTABLE_NAME} cache reset${ncc()}
${ncc('Cyan')}${EXECUTABLE_NAME} cache delete ${ncc('Dim')}<key|prefix> [more...]${ncc()}
${ncc('Cyan')}${EXECUTABLE_NAME} cache enable${ncc()}
${ncc('Cyan')}${EXECUTABLE_NAME} cache disable${ncc()}

Examples:
   ${ncc('Cyan')}${EXECUTABLE_NAME} cache prune ${ncc() + ncc('Dim')}# Remove expired cache entries${ncc()}
   ${ncc('Cyan')}${EXECUTABLE_NAME} cache reset ${ncc() + ncc('Dim')}# Delete cache file entirely${ncc()}
   ${ncc('Cyan')}${EXECUTABLE_NAME} cache delete git git.config ${ncc() + ncc('Dim')}# Expire by key/prefix${ncc()}
   ${ncc('Cyan')}${EXECUTABLE_NAME} cache disable ${ncc() + ncc('Dim')}# Turn caching off${ncc()}
`,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            mode: 'softboundary',
            indent: '  ',
         }
      ),
} as const satisfies CommandHelpObj;

export const structure = {
   $root: ['prune', 'reset', 'delete', 'enable', 'disable'],
} as const satisfies CommandStructure;
