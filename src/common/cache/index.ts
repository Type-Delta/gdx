import path from 'path';

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from '@/modules/fs';
import { CACHE_PATH, DEFAULT_CACHE_MAX_AGE, VERSION } from '@/consts';
import { beforeExit, Err } from '@lib/Tools';
import Logger from '@/utils/logger';
import { getConfig } from '../config';

interface CacheMetadata {
   version: string;
   createdAt: number;
   updatedAt: number;
   expiresAt: number;
}

interface CacheStructure {
   meta: CacheMetadata;
   data: Record<string, unknown>;
}

const DEFAULT_CACHE: CacheStructure = {
   meta: {
      version: VERSION,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: Date.now() + DEFAULT_CACHE_MAX_AGE * 60 * 1000,
   },
   data: {},
};

export class CacheService {
   private cachePath: string;
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

         // Check expiry
         if (Date.now() > parsed.meta.expiresAt) {
            Logger.debug(
               `Cache expired. expiresAt=${new Date(parsed.meta.expiresAt).toISOString()}, now=${new Date().toISOString()}`,
               'cache'
            );
            this.resetCache(false);
            this.loaded = true;
            return;
         }

         this.cache = parsed;
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
    */
   async get<T = unknown>(keyPath: string): Promise<T | undefined>;
   async get<T = unknown>(keyPath: string, defaultValue: T): Promise<T>;
   async get<T = unknown>(keyPath: string, defaultValue?: T): Promise<T | undefined> {
      if (CacheService.isDisabled) return defaultValue;
      await this.ensureLoaded();

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
    * Marks cache as dirty; actual write is deferred until flush().
    */
   async set(keyPath: string, value: any): Promise<void> {
      if (CacheService.isDisabled) return;
      const config = await getConfig();
      await this.ensureLoaded();

      const keys = keyPath.split('.');
      let target: any = this.cache.data;
      const cacheMaxAge = config.get<number>('cache.maxAgeMinutes') ?? DEFAULT_CACHE_MAX_AGE;

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

      // Update metadata and mark dirty
      this.cache.meta.updatedAt = Date.now();
      this.cache.meta.expiresAt = Date.now() + cacheMaxAge * 60 * 1000;
      this.dirty = true;
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
         const cacheJson = JSON.stringify(this.cache, null, 2);
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
      if (!CacheService.isDisabled)
         registerExitHook();
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
