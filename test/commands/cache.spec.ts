import { describe, expect } from 'bun:test';
import fs from 'fs/promises';

import cache from '@/commands/cache';
import { getCache, resetCache } from '@/common/cache';
import { getConfig, resetConfig } from '@/common/config';
import { CACHE_PATH } from '@/consts';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';

describe('gdx cache', async () => {
   const { tmpDir, buffer, it } = await createTestEnv();

   it('should reset cache file', async () => {
      resetCache();
      const cacheService = await getCache();
      await cacheService.set('git.version', '2.42.0');
      cacheService.flush();

      const ctx = createGdxContext(tmpDir, ['cache', 'reset']);
      const result = await cache(ctx);
      expect(result).toBe(0);

      const exists = await fs
         .stat(CACHE_PATH)
         .then(() => true)
         .catch(() => false);
      expect(exists).toBe(false);
      expect(buffer.stdout).toContain('Cache file deleted');
   });

   it('should expire cache entries by key and prefix', async () => {
      resetCache();
      const cacheService = await getCache();
      await cacheService.set('git.version', '2.42.0');
      await cacheService.set('git.repoRoot.abcd', '/tmp/repo');
      await cacheService.set('which.git', '/usr/bin/git');
      cacheService.flush();

      const ctx = createGdxContext(tmpDir, ['cache', 'delete', 'git']);
      const result = await cache(ctx);
      expect(result).toBe(0);

      const content = await fs.readFile(CACHE_PATH, 'utf-8');
      const parsed = JSON.parse(content);
      const now = Date.now();

      expect(parsed.entryMeta['git.version'].expiresAt).toBeLessThan(now);
      expect(parsed.entryMeta['git.repoRoot.abcd'].expiresAt).toBeLessThan(now);
      expect(parsed.entryMeta['which.git'].expiresAt).toBeGreaterThan(now);
      expect(parsed.data.git.version).toBe('2.42.0');
   });

   it('should prune expired keys', async () => {
      resetCache();
      const cacheService = await getCache();
      await cacheService.set('key.a', 'value-a', { maxAgeMinutes: 1 / 600 });
      await cacheService.set('key.b', 'value-b', { maxAgeMinutes: 60 });
      cacheService.flush();

      await new Promise((resolve) => setTimeout(resolve, 150));

      const ctx = createGdxContext(tmpDir, ['cache', 'prune']);
      const result = await cache(ctx);
      expect(result).toBe(0);

      const content = await fs.readFile(CACHE_PATH, 'utf-8');
      const parsed = JSON.parse(content);

      expect(parsed.entryMeta['key.a']).toBeUndefined();
      expect(parsed.entryMeta['key.b']).toBeDefined();
      expect(parsed.data.key?.a).toBeUndefined();
      expect(parsed.data.key.b).toBe('value-b');
   });

   it('should list cache keys with ttl and preview', async () => {
      resetCache();
      const cacheService = await getCache();
      await cacheService.set('list.string', 'hello world');
      await cacheService.set('list.obj', { a: 1, b: true });
      cacheService.flush();

      const ctx = createGdxContext(tmpDir, ['cache', 'list']);
      const result = await cache(ctx);
      expect(result).toBe(0);

      expect(buffer.stdout).toContain('list.string');
      expect(buffer.stdout).toContain('list.obj');
      expect(buffer.stdout).toContain('ttl=');
      expect(buffer.stdout).toContain('preview=');
   });

   it('should enable and disable cache in config', async () => {
      resetConfig();
      const ctxDisable = createGdxContext(tmpDir, ['cache', 'disable']);
      const resultDisable = await cache(ctxDisable);
      expect(resultDisable).toBe(0);

      resetConfig();
      const config = await getConfig();
      expect(config.get<boolean>('cache.enabled', true)).toBe(false);

      const ctxEnable = createGdxContext(tmpDir, ['cache', 'enable']);
      const resultEnable = await cache(ctxEnable);
      expect(resultEnable).toBe(0);

      expect(config.get<boolean>('cache.enabled', false)).toBe(true);
   });
});
