import { afterAll, describe, expect } from 'bun:test';
import path from 'path';

import { CheckCache } from '@lib/Tools';

import { getCache, resetCache } from '@/common/cache';
import * as fs from '@/modules/fs';
import { stripAnsiColor } from '@/modules/graphics';
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
      expect(buffer.stdout).toContain('First Commit');
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

         const totalCommitsLine = stripAnsiColor(buffer.stdout)
            .split('\n')
            .find((line) => line.includes('Total Commits'));
         expect(totalCommitsLine).toBeTruthy();
         expect(totalCommitsLine).not.toContain('(all)');
         expect(totalCommitsLine).toContain('0 orphan');
         expect(buffer.stdout).toContain('Object Inventory:');

         expect(buffer.stdout).toContain('Most Active User');
         expect(buffer.stdout).toContain('First Commit');
      } finally {
         await $`${git$} config user.email "test@example.com"`;
      }
   });

   it('should hide object inventory rows in author scope', async () => {
      await seedLanguageCatalog();

      const result = await stats(ctx);
      expect(result).toBe(0);
      expect(buffer.stdout).not.toContain('Object Inventory:');
   });

   it('should report the top contributor in --all mode', async () => {
      await seedLanguageCatalog();

      await fs.writeFile(path.join(tmpDir, 'main.ts'), 'line 1\nline 2\nline 3\nline 4\n');
      await $`${git$} add main.ts`;
      await $`${git$} -c user.name=${'Alice'} -c user.email=${'alice@example.com'} commit -m ${'alice change'}`;

      await fs.writeFile(path.join(tmpDir, 'main.ts'), 'line 1\nline 2\nline 3\n');
      await $`${git$} add main.ts`;
      await $`${git$} -c user.name=${'Bob'} -c user.email=${'bob@example.com'} commit -m ${'bob change'}`;

      const allCtx = createGdxContext(tmpDir, ['stats', '--all']);
      const result = await stats(allCtx);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain('Most Active User');
      expect(buffer.stdout).toContain('Alice');
   });

   it('should append submodule count to project name when submodules exist', async () => {
      await seedLanguageCatalog();

      const submoduleRepoPath = path.join(tmpDir, 'submodule-src');
      await $`${git$} init ${submoduleRepoPath}`;
      await $`${git$} -C ${submoduleRepoPath} config user.name ${'Test User'}`;
      await $`${git$} -C ${submoduleRepoPath} config user.email ${'test@example.com'}`;
      await fs.writeFile(path.join(submoduleRepoPath, 'README.md'), 'submodule\n');
      await $`${git$} -C ${submoduleRepoPath} add README.md`;
      await $`${git$} -C ${submoduleRepoPath} commit -m ${'init submodule repo'}`;

      await $`${git$} -c protocol.file.allow=always submodule add ${submoduleRepoPath} deps/sub-one`;
      await $`${git$} add .gitmodules deps/sub-one`;
      await $`${git$} commit -m ${'add submodule'}`;

      const result = await stats(ctx);
      expect(result).toBe(0);

      const projectLine = stripAnsiColor(buffer.stdout)
         .split('\n')
         .find((line) => line.includes('Project:'));
      expect(projectLine).toBeTruthy();
      expect(projectLine).toContain('(1 submodules)');
   });

   it('should render hyperlinks for project and usernames when supported', async () => {
      await seedLanguageCatalog();
      const originalHyperlinkSupport = CheckCache.supportsHyperlink;
      CheckCache.supportsHyperlink = true;

      try {
         await $`${git$} remote add origin ${'https://github.com/octo-org/demo-repo.git'}`;
         resetCache();
         await seedLanguageCatalog();
         const result = await stats(ctx);
         expect(result).toBe(0);

         expect(buffer.stdout).toContain('\x1b]8;;https://github.com/octo-org/demo-repo\x07');
         expect(buffer.stdout).toContain('\x1b]8;;https://github.com/Test%20User\x07');
      } finally {
         CheckCache.supportsHyperlink = originalHyperlinkSupport;
      }
   });

   it('should show oldest commit as first commit for selected scope', async () => {
      await seedLanguageCatalog();

      await $`${git$} -c user.name=${'Alice'} -c user.email=${'alice@example.com'} commit --allow-empty -m ${'alice 1'}`;
      await $`${git$} -c user.name=${'Bob'} -c user.email=${'bob@example.com'} commit --allow-empty -m ${'bob 1'}`;
      await $`${git$} -c user.name=${'Alice'} -c user.email=${'alice@example.com'} commit --allow-empty -m ${'alice 2'}`;

      const authorCtx = createGdxContext(tmpDir, ['stats', '--author', 'alice@example.com']);
      const result = await stats(authorCtx);
      expect(result).toBe(0);

      const firstLine = stripAnsiColor(buffer.stdout)
         .split('\n')
         .find((line) => line.includes('First Commit:'));
      const lastLine = stripAnsiColor(buffer.stdout)
         .split('\n')
         .find((line) => line.includes('Last Commit:'));

      expect(firstLine).toBeTruthy();
      expect(lastLine).toBeTruthy();
      const firstHash = firstLine?.match(/\[at\s+([a-f0-9]+)\]/i)?.[1];
      const lastHash = lastLine?.match(/\[at\s+([a-f0-9]+)\]/i)?.[1];
      expect(firstHash).toBeTruthy();
      expect(lastHash).toBeTruthy();
      expect(firstHash).not.toBe(lastHash);
   });

   it('should hide Contributions row in --all and keep it in author scope', async () => {
      await seedLanguageCatalog();

      const allCtx = createGdxContext(tmpDir, ['stats', '--all']);
      const allResult = await stats(allCtx);
      expect(allResult).toBe(0);
      expect(buffer.stdout).not.toContain('Contributions:');
      expect(buffer.stdout).toContain('Most Active User:');

      const authorCtx = createGdxContext(tmpDir, ['stats']);
      const authorResult = await stats(authorCtx);
      expect(authorResult).toBe(0);
      expect(buffer.stdout).toContain('Contributions:');
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
