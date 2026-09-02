import { describe, expect } from 'bun:test';

import { getCache } from '@/common/cache';
import {
   getLanguageCatalog,
   inferLanguageFromPath,
   languageConsts,
   resolveShikiLanguageIdForPath,
} from '@/modules/languages';
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
            catalogVersion: languageConsts.LANGUAGE_CATALOG_VERSION,
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
            catalogVersion: languageConsts.LANGUAGE_CATALOG_VERSION,
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

   it('should keep the cached catalog when a successful refresh has no languages', async () => {
      const cache = await getCache();
      const cachedCatalog = {
         catalogVersion: languageConsts.LANGUAGE_CATALOG_VERSION,
         lastUpdatedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
         languages: [
            {
               name: 'Python',
               extensions: ['.py'],
               filenames: [],
               color: parseInt('3572A5', 16),
               id: 303,
            },
         ],
      };
      await cache.set(languageConsts.LANGUAGE_CACHE_KEY, cachedCatalog, {
         maxAgeMinutes: Infinity,
      });

      const originalFetch = globalThis.fetch;
      const emptyPayloads = ['null', '"scalar"', '{}', ''];
      let payloadIndex = 0;
      globalThis.fetch = (async () =>
         new Response(emptyPayloads[payloadIndex++], { status: 200 })) as unknown as typeof fetch;

      try {
         for (let index = 0; index < emptyPayloads.length; index += 1) {
            const catalog = await getLanguageCatalog();
            expect(catalog?.languages[0].name).toBe('Python');
            expect(
               (await cache.get<typeof cachedCatalog>(languageConsts.LANGUAGE_CACHE_KEY))
                  ?.languages[0].name
            ).toBe('Python');
         }
         expect(payloadIndex).toBe(emptyPayloads.length);
      } finally {
         globalThis.fetch = originalFetch;
      }
   });

   it('should replace a recent empty cached catalog with a valid refresh', async () => {
      const cache = await getCache();
      await cache.set(
         languageConsts.LANGUAGE_CACHE_KEY,
         {
            catalogVersion: languageConsts.LANGUAGE_CATALOG_VERSION,
            lastUpdatedAt: new Date().toISOString(),
            languages: [],
         },
         { maxAgeMinutes: Infinity }
      );

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
         new Response(
            `TypeScript:
  type: programming
  color: "#3178c6"
  extensions:
  - ".ts"
  language_id: 378
`
         )) as unknown as typeof fetch;

      try {
         const catalog = await getLanguageCatalog();
         expect(catalog?.languages[0].name).toBe('TypeScript');
         expect(
            (await cache.get<typeof catalog>(languageConsts.LANGUAGE_CACHE_KEY))?.languages[0].name
         ).toBe('TypeScript');
      } finally {
         globalThis.fetch = originalFetch;
      }
   });

   it('should return null when refreshing a recent empty cached catalog fails', async () => {
      const cache = await getCache();
      await cache.set(
         languageConsts.LANGUAGE_CACHE_KEY,
         {
            catalogVersion: languageConsts.LANGUAGE_CATALOG_VERSION,
            lastUpdatedAt: new Date().toISOString(),
            languages: [],
         },
         { maxAgeMinutes: Infinity }
      );

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
         throw new Error('network down');
      }) as unknown as typeof fetch;

      try {
         expect(await getLanguageCatalog()).toBeNull();
      } finally {
         globalThis.fetch = originalFetch;
      }
   });

   it('should remove conflicting extensions from all conflicting languages', async () => {
      const cache = await getCache();
      await cache.set(
         languageConsts.LANGUAGE_CACHE_KEY,
         {
            catalogVersion: languageConsts.LANGUAGE_CATALOG_VERSION,
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

   it('should resolve catalog languages to Shiki language ids', async () => {
      const cache = await getCache();
      await cache.set(
         languageConsts.LANGUAGE_CACHE_KEY,
         {
            catalogVersion: languageConsts.LANGUAGE_CATALOG_VERSION,
            lastUpdatedAt: new Date().toISOString(),
            languages: [
               {
                  name: 'TypeScript',
                  extensions: ['.ts'],
                  filenames: [],
                  color: parseInt('3178c6', 16),
                  id: 378,
               },
               {
                  name: 'Dockerfile',
                  extensions: [],
                  filenames: ['Dockerfile'],
                  color: 0x384d54,
                  id: 89,
               },
            ],
         },
         { maxAgeMinutes: Infinity }
      );

      const catalog = await getLanguageCatalog();
      expect(catalog).not.toBeNull();
      expect(inferLanguageFromPath(catalog!, 'Dockerfile')?.name).toBe('Dockerfile');
      expect(await resolveShikiLanguageIdForPath('src/app.ts', catalog)).toBe('typescript');
      expect(await resolveShikiLanguageIdForPath('Dockerfile', catalog)).toBe('docker');
   });

   it('should refresh cached catalog when catalog version is missing', async () => {
      const cache = await getCache();
      await cache.set(
         languageConsts.LANGUAGE_CACHE_KEY,
         {
            lastUpdatedAt: new Date().toISOString(),
            languages: [
               {
                  name: 'OldLang',
                  extensions: ['.old'],
                  filenames: [],
                  color: 0x111111,
                  id: 1003,
               },
            ],
         },
         { maxAgeMinutes: Infinity }
      );

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
         new Response(
            `TypeScript:
  type: programming
  color: "#3178c6"
  extensions:
  - ".ts"
  language_id: 378
`
         )) as unknown as typeof fetch;

      try {
         const catalog = await getLanguageCatalog();
         expect(catalog).not.toBeNull();
         expect(catalog!.catalogVersion).toBe(languageConsts.LANGUAGE_CATALOG_VERSION);
         expect(inferLanguageFromPath(catalog!, 'src/app.ts')?.name).toBe('TypeScript');
         expect(inferLanguageFromPath(catalog!, 'src/app.old')).toBeNull();
      } finally {
         globalThis.fetch = originalFetch;
      }
   });
});
