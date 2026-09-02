/* eslint-disable @typescript-eslint/no-explicit-any */
import path from 'path';
import nodeFs from 'fs';
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
import { CacheEntryMetadata, CacheStructure, ZCacheStructure } from '../schema';
import { assertSchema } from '@/modules/typebox';

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
const CACHE_LOCK_STALE_MS = 30_000;
const CACHE_LOCK_WAIT_MS = 250;

export class CacheService {
   cachePath: string;
   isDisabled = false;

   private cache: CacheStructure = { ...DEFAULT_CACHE };
   private memoryData: Record<string, unknown> = {};
   private memoryEntryMeta: Record<string, Omit<CacheEntryMetadata, 'expiresAt'>> = {};
   private loaded = false;
   private dirty = false;
   private cleared = false;
   private readonly modifiedKeys = new Set<string>();
   private readonly deletedKeys = new Set<string>();
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
         if (meta.expiresAt !== INFINITE_TTL_EXPIRES_AT && now >= meta.expiresAt) {
            expiredKeys.push(keyPath);
         }
      }

      // Delete each expired entry
      for (const keyPath of expiredKeys) {
         // Remove from entryMeta
         delete this.cache.entryMeta[keyPath];
         this.modifiedKeys.delete(keyPath);
         this.deletedKeys.add(keyPath);

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
         this.cleared = true;
         this.modifiedKeys.clear();
         this.deletedKeys.clear();
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
         return defaultValue;
      }

      if (Date.now() >= entry.expiresAt) {
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
      if (this.isDisabled) return;

      assertJsonCacheValue(value);

      const keys = keyPath.split('.');
      let target: any = this.cache.data;
      const cacheMaxAge =
         options?.maxAgeMinutes ??
         config.get<number>('cache.maxAgeMinutes') ??
         DEFAULT_CACHE_MAX_AGE;
      if (cacheMaxAge !== Infinity && !Number.isFinite(cacheMaxAge)) {
         throw new RangeError('Cache maxAgeMinutes must be finite or Infinity.');
      }

      this.logger.debug(`Setting cache ${keyPath} with maxAgeMinutes=${cacheMaxAge}`);

      let currentValue: any = this.cache.data;
      for (const key of keys) {
         if (!currentValue || typeof currentValue !== 'object' || !(key in currentValue)) {
            currentValue = undefined;
            break;
         }
         currentValue = currentValue[key];
      }
      for (let i = 1; i < keys.length; i++) {
         this.markKeyDeleted(keys.slice(0, i).join('.'));
      }
      if (currentValue && typeof currentValue === 'object') {
         for (const existingKey of Object.keys(this.cache.entryMeta)) {
            if (existingKey.startsWith(`${keyPath}.`)) this.markKeyDeleted(existingKey);
         }
      }

      // Ensure intermediate objects exist
      for (let i = 0; i < keys.length - 1; i++) {
         const key = keys[i];
         if (
            !(key in target) ||
            target[key] === null ||
            typeof target[key] !== 'object' ||
            Array.isArray(target[key])
         ) {
            target[key] = {};
         }
         target = target[key];
      }

      const lastKey = keys[keys.length - 1];
      target[lastKey] = value;

      // Update per-key metadata
      const now = Date.now();
      const maxFiniteMinutes = (INFINITE_TTL_EXPIRES_AT - now) / (60 * 1000);
      const expiresAt =
         cacheMaxAge === Infinity || cacheMaxAge > maxFiniteMinutes
            ? INFINITE_TTL_EXPIRES_AT
            : now + Math.max(cacheMaxAge, 0) * 60 * 1000;
      this.cache.entryMeta[keyPath] = {
         createdAt: this.cache.entryMeta[keyPath]?.createdAt ?? now,
         updatedAt: now,
         expiresAt,
      };
      this.modifiedKeys.add(keyPath);
      this.deletedKeys.delete(keyPath);

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

      for (let i = 1; i < keys.length; i++) {
         delete this.memoryEntryMeta[keys.slice(0, i).join('.')];
      }
      for (const existingKey of Object.keys(this.memoryEntryMeta)) {
         if (existingKey.startsWith(`${keyPath}.`)) delete this.memoryEntryMeta[existingKey];
      }

      for (let i = 0; i < keys.length - 1; i++) {
         const key = keys[i];
         if (!(key in target) || target[key] === null || typeof target[key] !== 'object') {
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
      if (this.isDisabled) return false;

      // Check if entry exists
      if (!this.cache.entryMeta[keyPath]) {
         return false;
      }

      // Remove from entryMeta
      delete this.cache.entryMeta[keyPath];
      this.modifiedKeys.delete(keyPath);
      const deletedAt = Date.now();
      this.deletedKeys.add(keyPath);

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

      this.cache.meta.updatedAt = deletedAt;
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

      return true;
   }

   /**
    * Clears only the in-memory (one-off) cache data and metadata.
    */
   async clearOneOff(): Promise<void> {
      await this.ensureLoaded();
      this.resetMemoryCache();
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
         fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
         const lockPath = `${this.cachePath}.lock`;
         const lock = this.acquireFlushLock(lockPath);

         const tmpPath = path.join(
            dirPath,
            `${path.basename(this.cachePath)}.tmp.${process.pid}.${Date.now()}`
         );
         try {
            const cacheToWrite = this.mergeWithDiskCache();
            fs.writeFileSync(tmpPath, JSON.stringify(cacheToWrite), {
               encoding: 'utf-8',
               mode: 0o600,
            });
            nodeFs.renameSync(tmpPath, this.cachePath);
            this.cache = cacheToWrite;
            this.dirty = false;
            this.cleared = false;
            this.modifiedKeys.clear();
            this.deletedKeys.clear();
            this.logger.debug(`Cache flushed to ${this.cachePath}`);
         } finally {
            this.releaseFlushLock(lockPath, lock);
         }
      } catch (e) {
         const err = new Err(e);
         this.logger.warn(`Failed to flush cache: ${err.message}`);
      }
   }

   /**
    * Acquires the cross-process flush lock, waiting briefly for another flush to finish.
    * @param lockPath - The exclusive lock file path.
    * @returns The lock file descriptor.
    */
   private acquireFlushLock(lockPath: string): { fd: number; token: string } {
      this.removeStaleLockQuarantines(lockPath);
      const deadline = Date.now() + CACHE_LOCK_WAIT_MS;
      const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
      while (true) {
         try {
            const fd = nodeFs.openSync(lockPath, 'wx', 0o600);
            const lockStat = nodeFs.fstatSync(fd);
            const token = `${process.pid}.${Date.now()}.${Math.random()}`;
            try {
               nodeFs.writeFileSync(fd, token, 'utf-8');
               return { fd, token };
            } catch (e) {
               nodeFs.closeSync(fd);
               try {
                  const pathStat = nodeFs.statSync(lockPath);
                  if (pathStat.dev === lockStat.dev && pathStat.ino === lockStat.ino) {
                     nodeFs.unlinkSync(lockPath);
                  }
               } catch {
                  // The failed lock was already removed or replaced.
               }
               throw e;
            }
         } catch (e) {
            const err = new Err(e);
            if (err.code !== 'EEXIST' || Date.now() >= deadline) throw e;
            if (this.removeStaleFlushLock(lockPath)) continue;
            Atomics.wait(waitBuffer, 0, 0, 10);
         }
      }
   }

   /**
    * Removes abandoned stale-lock quarantines after the same stale threshold as locks.
    * @param lockPath - The primary lock file path used as the quarantine prefix.
    */
   private removeStaleLockQuarantines(lockPath: string): void {
      const dirPath = path.dirname(lockPath);
      const prefix = `${path.basename(lockPath)}.stale.`;
      try {
         for (const fileName of nodeFs.readdirSync(dirPath)) {
            if (!fileName.startsWith(prefix)) continue;
            const quarantinePath = path.join(dirPath, fileName);
            const cleanupPath = `${quarantinePath}.cleanup.${process.pid}.${Math.random()}`;
            try {
               const initialStat = nodeFs.statSync(quarantinePath);
               if (Date.now() - initialStat.mtimeMs < CACHE_LOCK_STALE_MS) continue;
               nodeFs.renameSync(quarantinePath, cleanupPath);
               const currentStat = nodeFs.statSync(cleanupPath);
               if (initialStat.dev === currentStat.dev && initialStat.ino === currentStat.ino) {
                  nodeFs.unlinkSync(cleanupPath);
               } else if (!nodeFs.existsSync(quarantinePath)) {
                  nodeFs.renameSync(cleanupPath, quarantinePath);
               }
            } catch {
               // Another process may already have reclaimed or removed it.
            }
         }
      } catch {
         // Cache flushing can continue when quarantine cleanup is unavailable.
      }
   }

   /**
    * Removes a stale lock only when its age and owner token remain unchanged.
    * @param lockPath - The lock file path.
    * @returns True when a stale lock was removed.
    */
   private removeStaleFlushLock(lockPath: string): boolean {
      const quarantinePath = `${lockPath}.stale.${process.pid}.${Date.now()}.${Math.random()}`;
      let isQuarantined = false;
      try {
         const initialStat = nodeFs.statSync(lockPath);
         if (Date.now() - initialStat.mtimeMs < CACHE_LOCK_STALE_MS) return false;
         const token = nodeFs.readFileSync(lockPath, 'utf-8');
         nodeFs.renameSync(lockPath, quarantinePath);
         isQuarantined = true;
         const currentStat = nodeFs.statSync(quarantinePath);
         if (
            initialStat.dev !== currentStat.dev ||
            initialStat.ino !== currentStat.ino ||
            initialStat.mtimeMs !== currentStat.mtimeMs ||
            initialStat.size !== currentStat.size ||
            nodeFs.readFileSync(quarantinePath, 'utf-8') !== token
         ) {
            if (!nodeFs.existsSync(lockPath)) nodeFs.renameSync(quarantinePath, lockPath);
            return false;
         }
         nodeFs.unlinkSync(quarantinePath);
         return true;
      } catch {
         if (isQuarantined && !nodeFs.existsSync(lockPath)) {
            try {
               nodeFs.renameSync(quarantinePath, lockPath);
            } catch {
               // Preserve the quarantine rather than risk deleting a replacement lock.
            }
         }
         return false;
      }
   }

   /**
    * Releases the flush lock without deleting a replacement owner's lock.
    * @param lockPath - The lock file path.
    * @param lock - The descriptor and ownership token returned during acquisition.
    */
   private releaseFlushLock(lockPath: string, lock: { fd: number; token: string }): void {
      nodeFs.closeSync(lock.fd);
      try {
         if (nodeFs.readFileSync(lockPath, 'utf-8') === lock.token) {
            nodeFs.unlinkSync(lockPath);
         }
      } catch {
         // The lock was already reclaimed or removed.
      }
   }

   /**
    * Applies this instance's mutations to the latest valid cache on disk.
    * @returns The merged cache structure to persist.
    */
   private mergeWithDiskCache(): CacheStructure {
      if (this.cleared) return this.cache;

      let diskCache: CacheStructure;
      try {
         const parsed = JSON.parse(nodeFs.readFileSync(this.cachePath, 'utf-8'));
         assertSchema(ZCacheStructure, parsed);
         diskCache = parsed;
      } catch {
         return this.cache;
      }

      for (const keyPath of this.deletedKeys) {
         delete diskCache.entryMeta[keyPath];
         const keys = keyPath.split('.');
         const parents: Array<{ obj: any; key: string }> = [];
         let current: any = diskCache.data;
         for (const key of keys) {
            if (!current || typeof current !== 'object' || !(key in current)) break;
            parents.push({ obj: current, key });
            current = current[key];
         }
         if (parents.length === keys.length) {
            const leaf = parents[parents.length - 1];
            delete leaf.obj[leaf.key];
            for (let i = parents.length - 2; i >= 0; i--) {
               const { obj, key } = parents[i];
               const child = obj[key];
               if (!child || typeof child !== 'object' || Object.keys(child).length > 0) break;
               delete obj[key];
            }
         }
      }

      for (const keyPath of this.modifiedKeys) {
         const keys = keyPath.split('.');
         let source: any = this.cache.data;
         let target: any = diskCache.data;
         for (let i = 0; i < keys.length - 1; i++) {
            if (!source || typeof source !== 'object' || !(keys[i] in source)) {
               source = undefined;
               break;
            }
            source = source[keys[i]];
            const key = keys[i];
            if (
               !(key in target) ||
               target[key] === null ||
               typeof target[key] !== 'object' ||
               Array.isArray(target[key])
            ) {
               target[key] = {};
            }
            target = target[key];
         }
         if (!source || typeof source !== 'object' || !(keys[keys.length - 1] in source)) {
            continue;
         }
         for (const existingKey of Object.keys(diskCache.entryMeta)) {
            if (
               existingKey !== keyPath &&
               (existingKey.startsWith(`${keyPath}.`) || keyPath.startsWith(`${existingKey}.`))
            ) {
               delete diskCache.entryMeta[existingKey];
            }
         }
         target[keys[keys.length - 1]] = source[keys[keys.length - 1]];
         diskCache.entryMeta[keyPath] = this.cache.entryMeta[keyPath];
      }

      diskCache.meta.version = VERSION;
      diskCache.meta.updatedAt = Math.max(diskCache.meta.updatedAt, this.cache.meta.updatedAt);
      diskCache.meta.lastPruneAt = Math.max(
         diskCache.meta.lastPruneAt,
         this.cache.meta.lastPruneAt
      );
      return diskCache;
   }

   /**
    * Records a key deletion when metadata exists in this instance.
    * @param keyPath - The dot-notation cache key to delete.
    */
   private markKeyDeleted(keyPath: string): void {
      if (!this.cache.entryMeta[keyPath]) return;
      delete this.cache.entryMeta[keyPath];
      this.modifiedKeys.delete(keyPath);
      this.deletedKeys.add(keyPath);
   }

   /**
    * Clears all cache data and marks as dirty.
    */
   async clear(): Promise<void> {
      await this.ensureLoaded();
      if (this.isDisabled) return;
      this.resetCache();
      this.resetMemoryCache();
   }
}

/**
 * Rejects values that JSON would drop, alter, or fail to serialize.
 * @param value - Candidate persistent cache value.
 */
function assertJsonCacheValue(value: unknown): void {
   const ancestors = new Set<object>();

   const visit = (current: unknown): void => {
      if (
         current === null ||
         typeof current === 'string' ||
         typeof current === 'boolean'
      ) {
         return;
      }
      if (typeof current === 'number') {
         if (Number.isFinite(current)) return;
         throw new TypeError('Persistent cache values cannot contain non-finite numbers.');
      }
      if (typeof current !== 'object') {
         throw new TypeError(`Persistent cache values cannot contain ${typeof current}.`);
      }
      if (ancestors.has(current)) {
         throw new TypeError('Persistent cache values cannot contain circular references.');
      }

      const prototype = Object.getPrototypeOf(current);
      if (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null) {
         throw new TypeError('Persistent cache values must contain only plain objects and arrays.');
      }

      ancestors.add(current);
      if (Array.isArray(current)) {
         for (const key of Reflect.ownKeys(current)) {
            if (key === 'length') continue;
            if (
               typeof key !== 'string' ||
               !/^(0|[1-9]\d*)$/.test(key) ||
               Number(key) >= current.length
            ) {
               throw new TypeError(
                  'Persistent cache arrays cannot contain custom or symbol properties.'
               );
            }
         }
         for (let index = 0; index < current.length; index++) {
            if (!Object.hasOwn(current, index)) {
               throw new TypeError('Persistent cache values cannot contain sparse arrays.');
            }
            visit(current[index]);
         }
      } else {
         for (const key of Reflect.ownKeys(current)) {
            if (typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(current, key)) {
               throw new TypeError('Persistent cache object properties must be enumerable strings.');
            }
            visit((current as Record<string, unknown>)[key]);
         }
      }
      ancestors.delete(current);
   };

   visit(value);
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
