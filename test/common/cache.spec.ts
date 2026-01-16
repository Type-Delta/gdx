/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, describe, expect } from 'bun:test';
import path from 'path';
import fs from 'fs/promises';

import { getCache, resetCache, CacheService } from '@/common/cache';
import { createTestEnv } from '@/utils/testHelper';
import { DEFAULT_CACHE_MAX_AGE, VERSION } from '@/consts';

describe('CacheService', async () => {
   const { tmpRootDir, cleanup, it } = await createTestEnv();
   afterAll(cleanup);

   const cacheFilePath = path.join(tmpRootDir, 'cache.json');

   it('should lazy-load cache on first access', async () => {
      resetCache();
      const cache = new CacheService(cacheFilePath);

      // File doesn't exist yet; should not read until get/set
      const cacheFileBefore = await fs.exists(cacheFilePath).catch(() => false);
      expect(cacheFileBefore).toBe(false);

      // First access triggers load
      const value = await cache.get('test.key');
      expect(value).toBeUndefined();

      // Load should still be complete without writing
      const cacheFileAfter = await fs.exists(cacheFilePath).catch(() => false);
      expect(cacheFileAfter).toBe(false);
   });

   it('should set and get values', async () => {
      resetCache();
      const cache = new CacheService(cacheFilePath);

      await cache.set('git.version', '2.42.0');
      const value = await cache.get('git.version');

      expect(value).toBe('2.42.0');

      // Verify entryMeta was created
      const allData = await cache.getAll();
      expect(allData.entryMeta['git.version']).toBeDefined();
      expect(allData.entryMeta['git.version'].expiresAt).toBeGreaterThan(Date.now());
   });

   it('should support nested key paths', async () => {
      resetCache();
      const cache = new CacheService(cacheFilePath);

      await cache.set('deeply.nested.value', 'hello');
      const value = await cache.get('deeply.nested.value');

      expect(value).toBe('hello');

      // Verify entryMeta uses flattened keyPath
      const allData = await cache.getAll();
      expect(allData.entryMeta['deeply.nested.value']).toBeDefined();
   });

   it('should return default value if key not found', async () => {
      resetCache();
      const cache = new CacheService(cacheFilePath);

      const value = await cache.get('nonexistent.key', 'default');
      expect(value).toBe('default');
   });

   it('should flush dirty cache to file', async () => {
      resetCache();
      const cache = new CacheService(cacheFilePath);

      await cache.set('test.data', 'value123');
      await cache.flush();

      // Verify file was written
      const fileExists = await fs.exists(cacheFilePath).catch(() => false);
      expect(fileExists).toBe(true);

      // Read and verify content
      const content = await fs.readFile(cacheFilePath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.data['test']['data']).toBe('value123');
      expect(parsed.meta.version).toBe(VERSION);
   });

   it('should not flush if not dirty', async () => {
      resetCache();
      const cacheFilePath2 = path.join(tmpRootDir, 'cache2.json');
      const cache = new CacheService(cacheFilePath2);

      // Just load without any modifications
      await cache.get('nonexistent');
      await cache.flush();

      // File should not exist since nothing changed
      const fileExists = await fs.exists(cacheFilePath2).catch(() => false);
      expect(fileExists).toBe(false);
   });

   it('should load persisted cache on next instance', async () => {
      resetCache();
      const cacheFile3 = path.join(tmpRootDir, 'cache3.json');

      // First instance: write data
      const cache1 = new CacheService(cacheFile3);
      await cache1.set('persist.test', 'persisted-value');
      await cache1.flush();

      // Second instance: read the same file
      const cache2 = new CacheService(cacheFile3);
      const value = await cache2.get('persist.test');

      expect(value).toBe('persisted-value');
   });

   it('should invalidate cache on VERSION mismatch', async () => {
      resetCache();
      const cacheFile4 = path.join(tmpRootDir, 'cache4.json');

      // Write cache with old version
      const oldCacheData = {
         meta: {
            version: 'old-version-1.0.0',
            createdAt: Date.now(),
            updatedAt: Date.now(),
         },
         data: { test: 'should-be-ignored' },
         entryMeta: {},
      };

      await fs.writeFile(cacheFile4, JSON.stringify(oldCacheData));

      // Load cache; should detect version mismatch
      const cache = new CacheService(cacheFile4);
      const value = await cache.get('test');

      // Data should be gone due to version mismatch
      expect(value).toBeUndefined();
   });

   it('should invalidate cache on expiry', async () => {
      resetCache();
      const cacheFile5 = path.join(tmpRootDir, 'cache5.json');

      // Write cache with one expired entry and one valid entry
      const expiredCacheData = {
         meta: {
            version: VERSION,
            createdAt: Date.now(),
            updatedAt: Date.now(),
         },
         data: { test: 'should-be-deleted', other: 'should-remain' },
         entryMeta: {
            test: {
               createdAt: Date.now(),
               updatedAt: Date.now(),
               expiresAt: Date.now() - 1000, // Already expired
            },
            other: {
               createdAt: Date.now(),
               updatedAt: Date.now(),
               expiresAt: Date.now() + 10000, // Not expired
            },
         },
      };

      await fs.writeFile(cacheFile5, JSON.stringify(expiredCacheData));

      // Load cache; should detect expiry for 'test' key only
      const cache = new CacheService(cacheFile5);
      const value = await cache.get('test');

      // Data should be gone due to expiry
      expect(value).toBeUndefined();

      // Other key should still be there
      const otherValue = await cache.get('other');
      expect(otherValue).toBe('should-remain');
   });

   it('should handle invalid JSON gracefully', async () => {
      resetCache();
      const cacheFile6 = path.join(tmpRootDir, 'cache6.json');

      // Write invalid JSON
      await fs.writeFile(cacheFile6, 'not-valid-json{');

      // Should not throw; should reset to defaults
      const cache = new CacheService(cacheFile6);
      const value = await cache.get('test');

      expect(value).toBeUndefined();

      // Verify entryMeta is initialized
      const allData = await cache.getAll();
      expect(allData.entryMeta).toBeDefined();
      expect(Object.keys(allData.entryMeta).length).toBe(0);
   });

   it('should update expiresAt on set', async () => {
      resetCache();
      const cache = new CacheService(cacheFilePath);

      await cache.set('test.key', 'value');
      const allData = await cache.getAll();

      // expiresAt should be approximately now + CACHE_MAX_AGE
      const expectedExpiry = Date.now() + DEFAULT_CACHE_MAX_AGE * 60 * 1000;
      const expiryDiff = Math.abs(allData.entryMeta['test.key'].expiresAt - expectedExpiry);

      expect(expiryDiff).toBeLessThan(1000); // Within 1 second
   });

   it('should clear all cache data', async () => {
      resetCache();
      const cache = new CacheService(cacheFilePath);

      await cache.set('test.key1', 'value1');
      await cache.set('test.key2', 'value2');

      // Verify data is there
      let value1 = await cache.get('test.key1');
      expect(value1).toBe('value1');

      // Clear cache
      await cache.clear();

      // Data should be gone
      value1 = await cache.get('test.key1');
      const value2 = await cache.get('test.key2');
      expect(value1).toBeUndefined();
      expect(value2).toBeUndefined();
   });

   it('should handle concurrent get calls with lazy load', async () => {
      resetCache();
      const cacheFile7 = path.join(tmpRootDir, 'cache7.json');
      const cache = new CacheService(cacheFile7);

      // Trigger multiple concurrent gets before load completes
      const [val1, val2, val3] = await Promise.all([
         cache.get('key1'),
         cache.get('key2'),
         cache.get('key3'),
      ]);

      // All should return undefined (not loaded yet, or loaded once)
      expect(val1).toBeUndefined();
      expect(val2).toBeUndefined();
      expect(val3).toBeUndefined();
   });

   it('should use singleton getCache()', async () => {
      resetCache();

      const cache1 = await getCache();
      const cache2 = await getCache();

      // Should be the same instance
      expect(cache1).toBe(cache2);
   });

   it('should retrieve cache path', async () => {
      resetCache();
      const customPath = path.join(tmpRootDir, 'custom-cache.json');
      const cache = new CacheService(customPath);

      expect(cache.getCachePath()).toBe(customPath);
   });

   it('should not invalidate unrelated keys when one expires', async () => {
      resetCache();
      const cacheFile8 = path.join(tmpRootDir, 'cache8.json');
      const cache = new CacheService(cacheFile8);

      // Set two keys with different expiry times
      await cache.set('key.a', 'value-a', { maxAgeMinutes: 1 / 600 }); // Expire in ~100ms
      await cache.set('key.b', 'value-b', { maxAgeMinutes: 60 }); // Expire later

      // Wait for key.a to expire
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Get key.a (should be expired and deleted)
      const valueA = await cache.get('key.a');
      expect(valueA).toBeUndefined();

      // Get key.b (should still exist)
      const valueB = await cache.get('key.b');
      expect(valueB).toBe('value-b');

      // Verify entryMeta
      const allData = await cache.getAll();
      expect(allData.entryMeta['key.a']).toBeUndefined();
      expect(allData.entryMeta['key.b']).toBeDefined();
   });

   it('should delete a key explicitly', async () => {
      resetCache();
      const cache = new CacheService(cacheFilePath);

      // Set a value
      await cache.set('to.delete', 'value');
      let value = await cache.get('to.delete');
      expect(value).toBe('value');

      // Delete it
      const deleted = await cache.delete('to.delete');
      expect(deleted).toBe(true);

      // Should be gone
      value = await cache.get('to.delete');
      expect(value).toBeUndefined();

      // Delete again should return false
      const deletedAgain = await cache.delete('to.delete');
      expect(deletedAgain).toBe(false);
   });

   it('should delete key and prune empty parents', async () => {
      resetCache();
      const cache = new CacheService(cacheFilePath);

      // Set nested values
      await cache.set('a.b.c.d', 'value1');
      await cache.set('a.b.c.e', 'value2');
      await cache.set('a.f', 'value3');

      // Delete one leaf
      await cache.delete('a.b.c.d');

      let allData = await cache.getAll();
      const dataA = allData.data.a as Record<string, any>;
      expect((dataA.b as Record<string, any>).c.e).toBe('value2'); // sibling still there
      expect(dataA.f).toBe('value3');

      // Delete other leaf of the parent
      await cache.delete('a.b.c.e');

      allData = await cache.getAll();
      const dataA2 = allData.data.a as Record<string, any>;
      expect(dataA2.b).toBeUndefined(); // parent pruned (now empty)
      expect(dataA2.f).toBe('value3'); // unrelated sibling still there
   });

   it('should support custom TTL per key on set', async () => {
      resetCache();
      const cache = new CacheService(cacheFilePath);

      const now = Date.now();

      // Set key with 10-minute TTL
      await cache.set('key.default', 'value1');
      // Set key with 5-minute TTL
      await cache.set('key.short', 'value2', { maxAgeMinutes: 5 });

      const allData = await cache.getAll();
      const defaultExpiry = allData.entryMeta['key.default'].expiresAt;
      const shortExpiry = allData.entryMeta['key.short'].expiresAt;

      // short expiry should be less than default
      expect(shortExpiry).toBeLessThan(defaultExpiry);
      expect(shortExpiry - now).toBeLessThan(5 * 60 * 1000 + 100); // ~5 min + margin
      expect(defaultExpiry - now).toBeGreaterThan(5 * 60 * 1000); // > 5 min
   });
});
