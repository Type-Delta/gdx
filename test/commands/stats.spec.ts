import { afterAll, describe, expect } from 'bun:test';
import path from 'path';

import { getCache } from '@/common/cache';
import * as fs from '@/modules/fs';
import { languageConsts } from '@/modules/languages';

import stats from '@/commands/stats';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';

describe('gdx stats', async () => {
   const { tmpDir, $, buffer, cleanup, it } = await createTestEnv({ autoResetBuffer: true });
   const ctx = createGdxContext(tmpDir);
   const { git$ } = ctx;

   async function seedLanguageCatalog() {
      const cache = await getCache();
      await cache.set(
         languageConsts.LANGUAGE_CACHE_KEY,
         {
            lastUpdatedAt: new Date().toISOString(),
            languages: [
               {
                  name: 'TypeScript',
                  extensions: ['.ts', '.tsx'],
                  color: parseInt('3178c6', 16),
               },
               {
                  name: 'JavaScript',
                  extensions: ['.js', '.jsx'],
                  color: parseInt('f1e05a', 16),
               },
            ],
         },
         { maxAgeMinutes: Infinity }
      );
   }

   await seedLanguageCatalog();

   afterAll(cleanup);

   it('should fail if no email configured (and not provided)', async () => {
      await seedLanguageCatalog();
      await $`${git$} config --unset user.email`;

      const result = await stats(ctx);
      expect(result).toBe(1);
      expect(buffer.stderr.toLowerCase()).toContain('no user.email configured');

      await $`${git$} config user.email "test@example.com"`;
   });

   it('should calculate stats for empty repo', async () => {
      await seedLanguageCatalog();
      const result = await stats(ctx);

      expect(result).toBe(0);
      // Should print stats (likely 0 commits)
      expect(buffer.stdout).toContain('Total Commits');
   });

   it('should calculate stats with commits', async () => {
      await seedLanguageCatalog();
      await $`${git$} commit --allow-empty -m ${'commit 1'}`;
      const result = await stats(ctx);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain('Total Commits');
      // We can't easily parse the output as it might be formatted, but we can check for presence of key strings.
   });

   it('should respect --author flag', async () => {
      await seedLanguageCatalog();
      const authorCtx = createGdxContext(tmpDir, ['stats', '--author', 'other@example.com']);
      const result = await stats(authorCtx);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain('other@example.com');
   });

   it('should support --all flag without configured email', async () => {
      await seedLanguageCatalog();
      await $`${git$} config user.email ${''}`;

      try {
         const allCtx = createGdxContext(tmpDir, ['stats', '--all']);
         const result = await stats(allCtx);
         expect(result).toBe(0);
         expect(buffer.stdout).toContain('all authors');
      } finally {
         await $`${git$} config user.email "test@example.com"`;
      }
   });

   it('should display language usage bar', async () => {
      await seedLanguageCatalog();
      await fs.writeFile(path.join(tmpDir, 'main.ts'), 'const a = 1;\nconst b = 2;\n');
      await fs.writeFile(path.join(tmpDir, 'app.js'), 'const x = 1;\n');
      await $`${git$} add .`;
      await $`${git$} commit -m ${'add source files'}`;

      await fs.writeFile(path.join(tmpDir, 'main.ts'), 'const a = 1;\n');
      await fs.writeFile(path.join(tmpDir, 'app.js'), 'const x = 1;\nconst y = 2;\n');
      await $`${git$} add .`;
      await $`${git$} commit -m ${'modify source files'}`;

      const result = await stats(ctx);
      expect(result).toBe(0);
      expect(buffer.stdout).toContain('Language Usage');
      expect(buffer.stdout).toContain('TypeScript');
      expect(buffer.stdout).toContain('JavaScript');
      expect(buffer.stdout).toContain('━');
   });

   it('should skip language usage bar when language catalog is unavailable', async () => {
      const cache = await getCache();
      await cache.delete(languageConsts.LANGUAGE_CACHE_KEY);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
         throw new Error('offline');
      }) as unknown as typeof fetch;

      try {
         await fs.writeFile(path.join(tmpDir, 'offline-test.ts'), 'const z = 1;\n');
         await $`${git$} add .`;
         await $`${git$} commit -m ${'offline lang catalog test'}`;

         const result = await stats(ctx);
         expect(result).toBe(0);
         expect(buffer.stdout).not.toContain('Language Usage');
      } finally {
         globalThis.fetch = originalFetch;
         await seedLanguageCatalog();
      }
   });
});
