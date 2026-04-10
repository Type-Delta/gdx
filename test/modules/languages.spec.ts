import { describe, expect } from 'bun:test';

import { getCache } from '@/common/cache';
import { getLanguageCatalog, inferLanguageFromPath, languageConsts } from '@/modules/languages';
import { createTestEnv } from '@/utils/testHelper';

describe('languages module', async () => {
   const { it } = await createTestEnv({
      autoResetBuffer: true,
      liteMode: true,
      suitName: 'languages'
   });

   it('should load catalog from cached value', async () => {
      const cache = await getCache();
      await cache.set(
         languageConsts.LANGUAGE_CACHE_KEY,
         {
            lastUpdatedAt: new Date().toISOString(),
            languages: [
               {
                  name: 'TypeScript',
                  extensions: ['.ts', '.tsx'],
                  filenames: [],
                  color: parseInt('3178c6', 16),
                  id: 378,
               },
            ],
         },
         { maxAgeMinutes: Infinity }
      );

      const catalog = await getLanguageCatalog();
      expect(catalog).not.toBeNull();
      expect(catalog!.languages.length).toBe(1);
      expect(catalog!.languages[0].name).toBe('TypeScript');
      expect(catalog!.languages[0].color).toBe(parseInt('3178c6', 16));
      expect(inferLanguageFromPath(catalog!, 'src/app.ts')?.name).toBe('TypeScript');
   });

   it('should use cached catalog when refresh fails', async () => {
      const cache = await getCache();
      await cache.set(
         languageConsts.LANGUAGE_CACHE_KEY,
         {
            lastUpdatedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
            languages: [
               {
                  name: 'Python',
                  extensions: ['.py'],
                  filenames: [],
                  color: parseInt('3572A5', 16),
                  id: 303,
               },
            ],
         },
         { maxAgeMinutes: Infinity }
      );

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
         throw new Error('network down');
      }) as unknown as typeof fetch;

      try {
         const catalog = await getLanguageCatalog();
         expect(catalog).not.toBeNull();
         expect(catalog!.languages[0].name).toBe('Python');
      } finally {
         globalThis.fetch = originalFetch;
      }
   });

   it('should remove conflicting extensions from all conflicting languages', async () => {
      const cache = await getCache();
      await cache.set(
         languageConsts.LANGUAGE_CACHE_KEY,
         {
            lastUpdatedAt: new Date().toISOString(),
            languages: [
               {
                  name: 'Lang A',
                  extensions: ['.x', '.a'],
                  filenames: [],
                  color: 0x111111,
                  id: 1001,
               },
               {
                  name: 'Lang B',
                  extensions: ['.x', '.b'],
                  filenames: [],
                  color: 0x222222,
                  id: 1002,
               },
            ],
         },
         { maxAgeMinutes: Infinity }
      );

      const catalog = await getLanguageCatalog();
      expect(catalog).not.toBeNull();

      expect(inferLanguageFromPath(catalog!, 'file.x')).toBeNull();
      expect(inferLanguageFromPath(catalog!, 'file.a')?.name).toBe('Lang A');
      expect(inferLanguageFromPath(catalog!, 'file.b')?.name).toBe('Lang B');
   });
});
