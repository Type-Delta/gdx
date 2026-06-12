import path from 'path';

import { Err, jsTime, strJustify, strLimit, strWrap, yuString } from '@lib/Tools';

import { resetCache } from '@/common/cache';
import { getConfig } from '@/common/config';
import { CommandHelpObj, CommandStructure, GdxContext } from '@/common/types';
import { CACHE_PATH, GDX_VPALETTE, EXECUTABLE_NAME, SGR } from '@/consts';
import global from '@/global';
import { _2PointGradient } from '@/modules/graphics';
import * as fs from '@/modules/fs';
import Logger from '@/utils/logger';
import { progressiveMatch, quickPrint } from '@/utils/utilities';
import { CacheStructure, ZCacheStructure } from '@/common/schema';
import litedent from '@/utils/litedent';
import { assertSchema } from '@/modules/typebox';

export default async function cache(ctx: GdxContext): Promise<number> {
   const inputCommand = ctx.args[1]?.toLowerCase();
   const { match: subcommand, candidates } = progressiveMatch(inputCommand, [
      'list',
      'prune',
      'reset',
      'delete',
      'disable',
      'enable',
   ]);

   switch (subcommand) {
      case 'list':
         return await listCache();
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
         if (candidates && candidates.length > 0) {
            Logger.warn(
               `Ambiguous command '${inputCommand}'. Did you mean one of: ${candidates.join(', ')}?`
            );
         }
         quickPrint(help.usage());
         return 0;
   }
}

async function pruneCache(): Promise<number> {
   let cacheData: CacheStructure | null;
   try {
      cacheData = await loadCacheFile();
   } catch (err) {
      Logger.error(yuString(err, { color: true }), 'cache');
      return 1;
   }

   if (!cacheData) {
      quickPrint(`${SGR.yellow}No valid cache found. Nothing to prune.${SGR.reset}`);
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
      quickPrint(`${SGR.green}Pruned ${prunedCount} expired cache entries.${SGR.reset}`);
   } else {
      quickPrint(`${SGR.cyan}No expired cache entries found.${SGR.reset}`);
   }

   return 0;
}

async function listCache(): Promise<number> {
   let cacheData: CacheStructure | null = null;
   try {
      cacheData = await loadCacheFile();
   } catch (err) {
      Logger.error(yuString(err, { color: true }), 'cache');
      return 1;
   }

   if (!cacheData) {
      quickPrint(`${SGR.yellow}No valid cache found. Nothing to list.${SGR.reset}`);
      return 0;
   }

   const keys = Object.keys(cacheData.entryMeta).sort((a, b) => {
      const aMeta = cacheData.entryMeta[a];
      const bMeta = cacheData.entryMeta[b];
      return (aMeta?.expiresAt ?? 0) - (bMeta?.expiresAt ?? 0) || a.localeCompare(b);
   });

   if (keys.length === 0) {
      quickPrint(`${SGR.yellow}No cache keys found.${SGR.reset}`);
      return 0;
   }

   quickPrint(
      `${SGR.cyan}Cache:${SGR.reset} ${CACHE_PATH} ${SGR.dim}(${keys.length} keys)${SGR.reset}\n`
   );

   for (const keyPath of keys) {
      const entry = cacheData.entryMeta[keyPath];
      if (!entry) continue;

      const ttlMs = entry.expiresAt - Date.now();
      const ttlLabel =
         ttlMs <= 0
            ? 'expired'
            : entry.expiresAt >= Number.MAX_SAFE_INTEGER
              ? 'N/A'
              : jsTime.getTimeFromMS(ttlMs).modern();
      let ttlColor = SGR.green;
      if (ttlMs <= 0) ttlColor = SGR.dim;
      else if (ttlMs < 60 * 60 * 1000) ttlColor = SGR.red;
      else if (ttlMs < 12 * 60 * 60 * 1000) ttlColor = SGR.yellow;

      const value = getValueAtPath(cacheData.data, keyPath);
      const preview = formatPreview(value);

      quickPrint(
         `${SGR.cyan}${strJustify(keyPath, 24, { align: 'left', redundancyLv: -1, overflow: 'collapse' })}${SGR.reset}  ttl=${ttlColor}${strJustify(ttlLabel, 12, { align: 'left', redundancyLv: -1, overflow: 'visible' })}${SGR.reset}  ${SGR.dim}preview=${preview}${SGR.reset}`
      );
   }

   return 0;
}

async function resetCacheFile(): Promise<number> {
   try {
      const existsBefore = fs.existsSync(CACHE_PATH);
      await fs.rm(CACHE_PATH, { force: true, recursive: true });
      resetCache();

      if (!existsBefore) {
         quickPrint(`${SGR.yellow}No valid cache found. Nothing to delete.${SGR.reset}`);
         return 0;
      }

      const message = fs.existsSync(CACHE_PATH)
         ? `${SGR.yellow}Cache file not removed: ${CACHE_PATH}${SGR.reset}`
         : `${SGR.green}Cache file deleted: ${CACHE_PATH}${SGR.reset}`;
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

   let cacheData: CacheStructure | null;
   try {
      cacheData = await loadCacheFile();
   } catch (err) {
      Logger.error(yuString(err, { color: true }), 'cache');
      return 1;
   }

   if (!cacheData) {
      quickPrint(`${SGR.yellow}No valid cache found. Nothing to delete.${SGR.reset}`);
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
      quickPrint(`${SGR.yellow}No matching cache keys found.${SGR.reset}`);
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
      quickPrint(`${SGR.green}Marked ${expiredCount} cache entries as expired.${SGR.reset}`);
      return 0;
   }

   quickPrint(`${SGR.yellow}No matching cache keys found.${SGR.reset}`);
   return 0;
}

async function setCacheEnabled(enabled: boolean): Promise<number> {
   const config = await getConfig();
   await config.set('cache.enabled', enabled);
   await config.save();

   const state = enabled ? 'enabled' : 'disabled';
   quickPrint(`${SGR.green}Cache ${state}.${SGR.reset}`);
   return 0;
}

async function loadCacheFile(): Promise<CacheStructure | null> {
   try {
      const content = await fs.readFile(CACHE_PATH, 'utf-8');
      const parsed = JSON.parse(content) as CacheStructure;

      try {
         assertSchema(ZCacheStructure, parsed); // Validate structure and types
      } catch {
         return null;
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
   // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

function getValueAtPath(data: Record<string, unknown>, keyPath: string): unknown {
   const keys = keyPath.split('.');
   // eslint-disable-next-line @typescript-eslint/no-explicit-any
   let value: any = data;
   for (const key of keys) {
      if (value && typeof value === 'object' && key in value) {
         value = value[key];
      } else {
         return undefined;
      }
   }
   return value;
}

function formatPreview(value: unknown): string {
   if (typeof value === 'string') {
      return `'${strLimit(value.replace(/\s+/g, ' '), 60, 'mid', -1)}'`;
   }

   if (typeof value === 'number' || typeof value === 'boolean' || value == null) {
      return String(value);
   }

   if (Array.isArray(value)) {
      const inner = strLimit(yuString(value, { color: false }), 60, 'mid', -1);
      return `[${value.length}] ${inner}`;
   }

   if (typeof value === 'object') {
      const inner = strLimit(yuString(value, { color: false }), 60, 'mid', -1);
      return `{...} ${inner}`;
   }

   return strLimit(String(value), 60, 'mid', -1);
}

export const help = {
   long: () => {
      return strWrap(
         litedent`
         ${SGR.bright + _2PointGradient('CACHE', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         Manually manage gdx cache entries and settings.

         ${SGR.bright + _2PointGradient('COMMANDS', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         - list: Show cache keys, TTL, and a short value preview.
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
      );
   },
   short: 'Manually manage gdx cache entries and settings.',
   usage: () => {
      return strWrap(
         litedent`
         ${SGR.cyan}${EXECUTABLE_NAME} cache prune${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} cache reset${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} cache list${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} cache delete ${SGR.dim}<key|prefix> [more...]${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} cache enable${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} cache disable${SGR.reset}

         Examples:
            ${SGR.cyan}${EXECUTABLE_NAME} cache list ${SGR.reset + SGR.dim}# List cached keys with TTL${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} cache prune ${SGR.reset + SGR.dim}# Remove expired cache entries${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} cache reset ${SGR.reset + SGR.dim}# Delete cache file entirely${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} cache delete git git.config ${SGR.reset + SGR.dim}# Expire by key/prefix${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} cache disable ${SGR.reset + SGR.dim}# Turn caching off${SGR.reset}
         `,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            mode: 'softboundary',
            indent: '  ',
         }
      );
   },
} as const satisfies CommandHelpObj;

export const structure = {
   $root: ['list', 'prune', 'reset', 'delete', 'enable', 'disable'],
} as const satisfies CommandStructure;
