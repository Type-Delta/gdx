/* eslint-disable @typescript-eslint/no-explicit-any */
import path from 'path';

import * as fs from '@/modules/fs';
import {
   CACHE_PATH,
   CACHE_PRUNE_INTERVAL_DAYS,
   DEFAULT_CACHE_MAX_AGE,
   ONE_DAY_MS,
   VERSION,
} from '@/consts';
import { beforeExit, Err } from '@lib/Tools';
import Logger from '@/utils/logger';
import { getConfig } from '../config';

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

const DEFAULT_CACHE: CacheStructure = {
   meta: {
      version: VERSION,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastPruneAt: Date.now(),
   },
   data: {},
   entryMeta: {},
};

export class CacheService {
   cachePath: string;

   private cache: CacheStructure = { ...DEFAULT_CACHE };
   private loaded = false;
   private dirty = false;
   private loadingPromise: Promise<void> | null = null;
   static isDisabled = false;

   constructor(cachePath?: string) {
      this.cachePath = cachePath || CACHE_PATH;
   }

   /**
    * Ensures the cache is loaded. Lazy-loads on first access.
    * Handles concurrent load requests via a shared promise.
    */
   private async ensureLoaded(): Promise<void> {
      if (this.loaded) return;

      if (this.loadingPromise) {
         await this.loadingPromise;
         return;
      }

      this.loadingPromise = this.load();
      try {
         await this.loadingPromise;
      } finally {
         this.loadingPromise = null;
      }
   }

   /**
    * Prunes all expired cache entries.
    * This is called periodically (every CACHE_PRUNE_INTERVAL_DAYS) to clean up stale data.
    * @returns The number of keys pruned.
    */
   private pruneExpiredKeys(): number {
      const now = Date.now();
      let prunedCount = 0;

      // Find all expired entries
      const expiredKeys: string[] = [];
      for (const [keyPath, meta] of Object.entries(this.cache.entryMeta)) {
         if (now > meta.expiresAt) {
            expiredKeys.push(keyPath);
         }
      }

      // Delete each expired entry
      for (const keyPath of expiredKeys) {
         // Remove from entryMeta
         delete this.cache.entryMeta[keyPath];

         // Remove from nested data structure
         const keys = keyPath.split('.');
         const pathToDelete: any[] = [];
         let current: any = this.cache.data;

         for (const key of keys) {
            if (current && typeof current === 'object' && key in current) {
               pathToDelete.push({ obj: current, key });
               current = current[key];
            } else {
               // Path doesn't exist; metadata was stale
               break;
            }
         }

         // Delete the leaf
         if (pathToDelete.length > 0) {
            const last = pathToDelete[pathToDelete.length - 1];
            delete last.obj[last.key];
            prunedCount++;
         }

         // Prune empty parent objects (walk back up)
         for (let i = pathToDelete.length - 2; i >= 0; i--) {
            const { obj, key } = pathToDelete[i];
            const child = obj[key];
            if (child && typeof child === 'object' && Object.keys(child).length === 0) {
               delete obj[key];
            } else {
               break; // Stop pruning if parent is not empty
            }
         }
      }

      // Update lastPruneAt timestamp
      this.cache.meta.lastPruneAt = now;
      if (prunedCount > 0) {
         this.cache.meta.updatedAt = now;
         this.dirty = true;
      }

      return prunedCount;
   }

   /**
    * Loads cache from file. Validates metadata and expiry.
    */
   private async load(): Promise<void> {
      if (this.loaded) return;
      const config = await getConfig();

      if (!config.get<boolean>('cache.enabled')) {
         this.resetCache(false);
         this.loaded = true;
         CacheService.isDisabled = true;
         Logger.debug('Cache is disabled via configuration', 'cache');
         return;
      }

      try {
         const fileContent = await fs.readFile(this.cachePath, 'utf-8');
         const parsed = JSON.parse(fileContent) as CacheStructure;

         // Validate schema
         if (!parsed.meta || !parsed.data) {
            this.resetCache(false);
            this.loaded = true;
            return;
         }

         // Check version mismatch (auto-invalidate on VERSION change)
         if (parsed.meta.version !== VERSION) {
            Logger.debug(
               `Cache version mismatch: stored=${parsed.meta.version}, current=${VERSION}. Resetting cache.`,
               'cache'
            );
            this.resetCache(false);
            this.loaded = true;
            return;
         }

         // Ensure required fields exist
         if (!parsed.entryMeta || !parsed.meta.lastPruneAt) {
            Logger.debug('Existing cache file\' schema mismatch; resetting cache to newer version', 'cache');
            this.resetCache(false);
            this.loaded = true;
            return;
         }

         this.cache = parsed;

         // Check if it's time to prune expired keys
         const now = Date.now();
         const daysSinceLastPrune = (now - this.cache.meta.lastPruneAt) / ONE_DAY_MS;

         if (daysSinceLastPrune >= CACHE_PRUNE_INTERVAL_DAYS) {
            Logger.debug(
               `Last prune was ${daysSinceLastPrune.toFixed(1)} days ago. Running cache pruning...`,
               'cache'
            );
            const prunedCount = this.pruneExpiredKeys();
            if (prunedCount > 0) {
               Logger.debug(`Pruned ${prunedCount} expired cache entries`, 'cache');
            } else {
               Logger.debug('No expired entries found during pruning', 'cache');
            }
         }
      } catch (e) {
         const err = new Err(e);
         if (err.code !== 'ENOENT') {
            // File exists but couldn't be parsed - not fatal
            Logger.debug(
               `Failed to parse cache file at ${this.cachePath}: ${err.message}`,
               'cache'
            );
         }
         // Use defaults if file doesn't exist or can't be parsed
         this.resetCache(false);
      }

      this.loaded = true;
   }

   /**
    * Resets cache to default state.
    * Optionally marks as dirty (only if explicitly requested).
    */
   private resetCache(markDirty = true): void {
      this.cache = structuredClone(DEFAULT_CACHE);
      if (markDirty) {
         this.dirty = true;
      }
   }

   /**
    * Gets a value by dot-notation key path (e.g., 'git.version').
    * Checks per-key expiry and lazy-deletes if expired.
    */
   async get<T = unknown>(keyPath: string): Promise<T | undefined>;
   async get<T = unknown>(keyPath: string, defaultValue: T): Promise<T>;
   async get<T = unknown>(keyPath: string, defaultValue?: T): Promise<T | undefined> {
      if (CacheService.isDisabled) return defaultValue;
      await this.ensureLoaded();

      // Check if entry is expired (lazy delete)
      const entry = this.cache.entryMeta[keyPath];

      // Entry not found in metadata (cache miss)
      if (!entry) {
         return defaultValue;
      }

      if (Date.now() > entry.expiresAt) {
         Logger.debug(
            `Cache entry expired: ${keyPath}. expiresAt=${new Date(entry.expiresAt).toISOString()}, now=${new Date().toISOString()}`,
            'cache'
         );
         await this.delete(keyPath);
         return defaultValue;
      }

      // Retrieve value from nested data structure
      const keys = keyPath.split('.');
      let value: any = this.cache.data;

      for (const key of keys) {
         if (value && typeof value === 'object' && key in value) {
            value = value[key];
         } else {
            return defaultValue;
         }
      }

      return value as T;
   }

   /**
    * Sets a value by dot-notation key path (e.g., 'git.version', '2.42.0').
    * Stores per-key metadata (TTL, timestamps).
    * Marks cache as dirty; actual write is deferred until flush().
    */
   async set(keyPath: string, value: any, options?: { maxAgeMinutes?: number }): Promise<void> {
      if (CacheService.isDisabled) return;
      const config = await getConfig();
      await this.ensureLoaded();

      const keys = keyPath.split('.');
      let target: any = this.cache.data;
      const cacheMaxAge =
         options?.maxAgeMinutes ??
         config.get<number>('cache.maxAgeMinutes') ??
         DEFAULT_CACHE_MAX_AGE;

      // Ensure intermediate objects exist
      for (let i = 0; i < keys.length - 1; i++) {
         const key = keys[i];
         if (!(key in target) || typeof target[key] !== 'object') {
            target[key] = {};
         }
         target = target[key];
      }

      const lastKey = keys[keys.length - 1];
      target[lastKey] = value;

      // Update per-key metadata
      const now = Date.now();
      this.cache.entryMeta[keyPath] = {
         createdAt: this.cache.entryMeta[keyPath]?.createdAt ?? now,
         updatedAt: now,
         expiresAt: now + cacheMaxAge * 60 * 1000,
      };

      // Update file-level metadata and mark dirty
      this.cache.meta.updatedAt = now;
      this.dirty = true;
   }

   /**
    * Deletes a value by dot-notation key path.
    * Removes the entry from both data and entryMeta.
    * Prunes empty parent objects.
    * @returns true if entry existed and was deleted, false otherwise.
    */
   async delete(keyPath: string): Promise<boolean> {
      if (CacheService.isDisabled) return false;
      await this.ensureLoaded();

      // Check if entry exists
      if (!this.cache.entryMeta[keyPath]) {
         return false;
      }

      // Remove from entryMeta
      delete this.cache.entryMeta[keyPath];

      // Remove from nested data structure
      const keys = keyPath.split('.');
      const pathToDelete: any[] = [];
      let current: any = this.cache.data;

      for (const key of keys) {
         if (current && typeof current === 'object' && key in current) {
            pathToDelete.push({ obj: current, key });
            current = current[key];
         } else {
            // Path doesn't exist; metadata was stale
            return false;
         }
      }

      // Delete the leaf
      if (pathToDelete.length > 0) {
         const last = pathToDelete[pathToDelete.length - 1];
         delete last.obj[last.key];
      }

      // Prune empty parent objects (walk back up)
      for (let i = pathToDelete.length - 2; i >= 0; i--) {
         const { obj, key } = pathToDelete[i];
         const child = obj[key];
         if (child && typeof child === 'object' && Object.keys(child).length === 0) {
            delete obj[key];
         } else {
            break; // Stop pruning if parent is not empty
         }
      }

      this.cache.meta.updatedAt = Date.now();
      this.dirty = true;
      Logger.debug(`Cache entry deleted: ${keyPath}`, 'cache');

      return true;
   }

   /**
    * Gets the entire cache data object.
    */
   async getAll(): Promise<Readonly<CacheStructure>> {
      await this.ensureLoaded();
      return this.cache;
   }

   /**
    * Gets the cache file path.
    */
   getCachePath(): string {
      return this.cachePath;
   }

   /**
    * Flushes cache to disk if dirty.
    * Called by the exit hook.
    */
   flush(): void {
      if (!this.dirty) {
         return;
      }

      try {
         const dirPath = path.dirname(this.cachePath);
         fs.mkdirSync(dirPath, { recursive: true });
         const cacheJson = JSON.stringify(this.cache);
         fs.writeFileSync(this.cachePath, cacheJson, 'utf-8');
         this.dirty = false;
         Logger.debug(`Cache flushed to ${this.cachePath}`, 'cache');
      } catch (e) {
         const err = new Err(e);
         Logger.warn(`Failed to flush cache: ${err.message}`, 'cache');
      }
   }

   /**
    * Clears all cache data and marks as dirty.
    */
   async clear(): Promise<void> {
      await this.ensureLoaded();
      this.resetCache();
   }
}

// Singleton instance
let instance: CacheService | null = null;

/**
 * Gets the singleton CacheService instance.
 * Auto-registers the exit hook on first access to ensure cache is flushed.
 */
export async function getCache(): Promise<CacheService> {
   if (!instance) {
      instance = new CacheService();
      await instance['ensureLoaded']();
      if (!CacheService.isDisabled) registerExitHook();
   }
   return instance;
}

/**
 * Resets the singleton instance (useful for testing).
 */
export function resetCache(): void {
   instance = null;
}

/**
 * Registers an async exit hook to flush the cache before process termination.
 * Uses best-effort approach: doesn't block process exit, but tries to flush.
 */
function registerExitHook(): void {
   Logger.debug('Registering cache flush hook on exit', 'cache');
   beforeExit(() => {
      if (instance) {
         instance.flush();
      }
   });
}
