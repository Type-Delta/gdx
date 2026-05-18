/* eslint-disable @typescript-eslint/no-explicit-any */
import path from 'path';
import * as fs from '@/modules/fs';

import { beforeExit, Err } from '@lib/Tools';

import {
   CACHE_PATH,
   CACHE_PRUNE_INTERVAL_DAYS,
   DEFAULT_CACHE_MAX_AGE,
   GDX_CACHE_SCHEMA_VERSION,
   ONE_DAY_MS,
   VERSION,
} from '@/consts';
import Logger from '@/utils/logger';
import { getConfig } from '../config';
import { assertSchema, CacheEntryMetadata, CacheStructure, ZCacheStructure } from '../schema';

const DEFAULT_CACHE: CacheStructure = {
   meta: {
      version: VERSION,
      cacheSchemaVersion: GDX_CACHE_SCHEMA_VERSION,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastPruneAt: Date.now(),
   },
   data: {},
   entryMeta: {},
};

export const INFINITE_TTL_EXPIRES_AT = Number.MAX_SAFE_INTEGER;

export class CacheService {
   cachePath: string;
   isDisabled = false;

   private cache: CacheStructure = { ...DEFAULT_CACHE };
   private memoryData: Record<string, unknown> = {};
   private memoryEntryMeta: Record<string, Omit<CacheEntryMetadata, 'expiresAt'>> = {};
   private loaded = false;
   private dirty = false;
   private loadingPromise: Promise<void> | null = null;
   private readonly logger = new Logger('cache');

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
         if (meta.expiresAt !== INFINITE_TTL_EXPIRES_AT && now > meta.expiresAt) {
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
         this.isDisabled = true;
         this.logger.debug('Cache is disabled via configuration');
         return;
      }

      try {
         const fileContent = await fs.readFile(this.cachePath, 'utf-8');
         const parsed = JSON.parse(fileContent) as CacheStructure;

         try {
            // Check version mismatch (auto-invalidate on cache version & structure change)
            assertSchema(ZCacheStructure, parsed); // Validate structure and types
         } catch {
            this.logger.warn(
               'Cache file structure is outdated or invalid. Cache will be reset on next write.'
            );
            this.resetCache(false);
            this.loaded = true;
            return;
         }

         if (parsed.meta.version !== VERSION) {
            this.logger.debug(
               `App version mismatch: stored=${parsed.meta.version}, current=${VERSION}. Updating version number.`
            );
            parsed.meta.version = VERSION;
            this.dirty = true; // Mark dirty to update version on next flush
         }

         this.cache = parsed;

         // Check if it's time to prune expired keys
         const now = Date.now();
         const daysSinceLastPrune = (now - this.cache.meta.lastPruneAt) / ONE_DAY_MS;

         if (daysSinceLastPrune >= CACHE_PRUNE_INTERVAL_DAYS) {
            this.logger.debug(
               `Last prune was ${daysSinceLastPrune.toFixed(1)} days ago. Running cache pruning...`
            );
            const prunedCount = this.pruneExpiredKeys();
            if (prunedCount > 0) {
               this.logger.debug(`Pruned ${prunedCount} expired cache entries`);
            } else {
               this.logger.debug('No expired entries found during pruning');
            }
         }
      } catch (e) {
         const err = new Err(e);
         if (err.code !== 'ENOENT') {
            // File exists but couldn't be parsed - not fatal
            this.logger.debug(`Failed to parse cache file at ${this.cachePath}: ${err.message}`);
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
    * Resets the in-memory (one-off) cache store.
    */
   private resetMemoryCache(): void {
      this.memoryData = {};
      this.memoryEntryMeta = {};
   }

   /**
    * Gets a value by dot-notation key path (e.g., 'git.version').
    * Checks per-key expiry and lazy-deletes if expired.
    */
   async get<T = unknown>(keyPath: string): Promise<T | undefined>;
   async get<T = unknown>(keyPath: string, defaultValue: T): Promise<T>;
   async get<T = unknown>(keyPath: string, defaultValue?: T): Promise<T | undefined> {
      if (this.isDisabled) return defaultValue;
      await this.ensureLoaded();

      // Check if entry is expired (lazy delete)
      const entry = this.cache.entryMeta[keyPath];

      // Entry not found in metadata (cache miss)
      if (!entry) {
         this.logger.debug(`Cache ${keyPath} missed.`);
         return defaultValue;
      }

      if (Date.now() > entry.expiresAt) {
         this.logger.debug(
            `Cache entry expired: ${keyPath}. expiresAt=${new Date(entry.expiresAt).toISOString()}, now=${new Date().toISOString()}`
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

      this.logger.debug(`Cache ${keyPath} hit.`);
      return value as T;
   }

   /**
    * Gets a value from the in-memory (one-off) cache only.
    * This does not touch disk and expires when the process exits.
    */
   async getOneOff<T = unknown>(keyPath: string): Promise<T | undefined>;
   async getOneOff<T = unknown>(keyPath: string, defaultValue: T): Promise<T>;
   async getOneOff<T = unknown>(keyPath: string, defaultValue?: T): Promise<T | undefined> {
      await this.ensureLoaded();
      if (this.isDisabled) return defaultValue;

      const entry = this.memoryEntryMeta[keyPath];
      if (!entry) {
         this.logger.debug(`Memory cache ${keyPath} missed.`);
         return defaultValue;
      }

      const keys = keyPath.split('.');
      let value: any = this.memoryData;

      for (const key of keys) {
         if (value && typeof value === 'object' && key in value) {
            value = value[key];
         } else {
            return defaultValue;
         }
      }

      this.logger.debug(`Memory cache ${keyPath} hit.`);
      return value as T;
   }

   /**
    * Sets a value by dot-notation key path (e.g., 'git.version', '2.42.0').
    * Stores per-key metadata (TTL, timestamps).
    * Marks cache as dirty; actual write is deferred until flush().
    */
   async set(keyPath: string, value: any, options?: { maxAgeMinutes?: number }): Promise<void> {
      if (this.isDisabled) return;
      const config = await getConfig();
      await this.ensureLoaded();

      const keys = keyPath.split('.');
      let target: any = this.cache.data;
      const cacheMaxAge =
         options?.maxAgeMinutes ??
         config.get<number>('cache.maxAgeMinutes') ??
         DEFAULT_CACHE_MAX_AGE;

      this.logger.debug(`Setting cache ${keyPath} with maxAgeMinutes=${cacheMaxAge}`);

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
      const expiresAt = Number.isFinite(cacheMaxAge)
         ? now + Math.max(cacheMaxAge, 0) * 60 * 1000
         : INFINITE_TTL_EXPIRES_AT;
      this.cache.entryMeta[keyPath] = {
         createdAt: this.cache.entryMeta[keyPath]?.createdAt ?? now,
         updatedAt: now,
         expiresAt,
      };

      // Update file-level metadata and mark dirty
      this.cache.meta.updatedAt = now;
      this.dirty = true;
   }

   /**
    * Sets a value in the in-memory (one-off) cache only.
    * This never writes to disk and expires when the process exits.
    */
   async setOneOff(keyPath: string, value: any): Promise<void> {
      await this.ensureLoaded();
      if (this.isDisabled) return;

      const keys = keyPath.split('.');
      let target: any = this.memoryData;

      this.logger.debug(`Setting memory cache ${keyPath}`);

      for (let i = 0; i < keys.length - 1; i++) {
         const key = keys[i];
         if (!(key in target) || typeof target[key] !== 'object') {
            target[key] = {};
         }
         target = target[key];
      }

      const lastKey = keys[keys.length - 1];
      target[lastKey] = value;

      const now = Date.now();
      this.memoryEntryMeta[keyPath] = {
         createdAt: this.memoryEntryMeta[keyPath]?.createdAt ?? now,
         updatedAt: now,
      };
   }

   /**
    * Deletes a value by dot-notation key path.
    * Removes the entry from both data and entryMeta.
    * Prunes empty parent objects.
    * @returns true if entry existed and was deleted, false otherwise.
    */
   async delete(keyPath: string): Promise<boolean> {
      if (this.isDisabled) return false;
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
      this.logger.debug(`Cache entry deleted: ${keyPath}`);

      return true;
   }

   /**
    * Deletes a value from the in-memory (one-off) cache.
    * @returns true if entry existed and was deleted, false otherwise.
    */
   async deleteOneOff(keyPath: string): Promise<boolean> {
      await this.ensureLoaded();
      if (this.isDisabled) return false;

      if (!this.memoryEntryMeta[keyPath]) {
         return false;
      }

      delete this.memoryEntryMeta[keyPath];

      const keys = keyPath.split('.');
      const pathToDelete: any[] = [];
      let current: any = this.memoryData;

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

      this.logger.debug(`Memory cache entry deleted: ${keyPath}`);

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
         this.logger.debug(`Cache flushed to ${this.cachePath}`);
      } catch (e) {
         const err = new Err(e);
         this.logger.warn(`Failed to flush cache: ${err.message}`);
      }
   }

   /**
    * Clears all cache data and marks as dirty.
    */
   async clear(): Promise<void> {
      await this.ensureLoaded();
      this.resetCache();
      this.resetMemoryCache();
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
      if (!instance.isDisabled) registerExitHook();
   }
   return instance;
}

/**
 * Resets the singleton instance (useful for testing).
 */
export function resetCache(): void {
   instance = null;
   // TODO: unsubscribe exit hook
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
