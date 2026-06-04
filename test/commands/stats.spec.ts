import { describe, expect } from 'bun:test';
import path from 'path';

import { CheckCache } from '@lib/Tools';

import { getCache, resetCache } from '@/common/cache';
import * as fs from '@/modules/fs';
import { addSubmodule } from '@/modules/git';
import { stripAnsiColor } from '@/modules/graphics';
import { languageConsts } from '@/modules/languages';

import stats from '@/commands/stats';
import {
   createGdxContext,
   createTestEnv,
   setTestGitConfig,
   unsetTestGitConfig,
} from '@/utils/testHelper';

describe('gdx stats', async () => {
   const { tmpDir, $, buffer, it, resetRepo } = await createTestEnv({
      autoResetBuffer: true,
      suitName: 'stats'
   });
   const ctx = createGdxContext(tmpDir);
   const { git$ } = ctx;

   async function seedLanguageCatalog() {
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

   it('should fail if no email configured (and not provided)', async () => {
      await seedLanguageCatalog();
      await unsetTestGitConfig(tmpDir, 'user.email');

      const result = await stats(ctx);
      expect(result).toBe(1);
      expect(buffer.stderr.toLowerCase()).toContain('no user.email configured');

      await setTestGitConfig(tmpDir, 'user.email', 'test@example.com');
   });

   it('should calculate stats for empty repo', async () => {
      // Reset repo to remove initial commit and ensure empty state
      const headTarget = fs.readFileSync(path.join(tmpDir, '.git', 'HEAD'), 'utf-8').trim();
      if (headTarget.startsWith('ref:')) {
         const refPath = path.join(tmpDir, '.git', headTarget.slice(5));
         if (fs.existsSync(refPath)) {
            fs.unlinkSync(refPath);
         }
         else {
            throw new Error(`Repo with packed refs is not supported.`);
         }
      }

      try {
         await seedLanguageCatalog();
         const result = await stats(ctx);

         expect(result).toBe(0);
         // Should print stats (likely 0 commits)
         expect(buffer.stdout).toContain('Total Commits');
         expect(buffer.stdout).toContain('First Commit');
         const totalCommits = /Total Commits:\s+(\d+)/.exec(stripAnsiColor(buffer.stdout));
         expect(totalCommits).toBeTruthy();
         expect(totalCommits![1]).toBe('0');
      } finally {
         resetRepo('full');
      }
   });

   it('should calculate stats with commits', async () => {
      await seedLanguageCatalog();
      await $`${git$} commit --allow-empty --no-verify -m ${'commit 1'}`;
      const result = await stats(ctx);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain('Total Commits');

      const totalCommits = /Total Commits:\s+(\d+)/.exec(stripAnsiColor(buffer.stdout));
      expect(totalCommits).toBeTruthy();
      expect(totalCommits![1]).toBe('2'); // 1 from initial commit + 1 above
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
      await setTestGitConfig(tmpDir, 'user.email', '');

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
         await setTestGitConfig(tmpDir, 'user.email', 'test@example.com');
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
      await $`${git$} -c user.name=${'Alice'} -c user.email=${'alice@example.com'} commit --no-verify -m ${'alice change'}`;

      await fs.writeFile(path.join(tmpDir, 'main.ts'), 'line 1\nline 2\nline 3\n');
      await $`${git$} add main.ts`;
      await $`${git$} -c user.name=${'Bob'} -c user.email=${'bob@example.com'} commit --no-verify -m ${'bob change'}`;

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
      await setTestGitConfig(submoduleRepoPath, 'user.name', 'Test User');
      await setTestGitConfig(submoduleRepoPath, 'user.email', 'test@example.com');
      await $`${git$} -C ${submoduleRepoPath} commit --allow-empty --no-verify -m ${'init submodule repo'}`;

      await addSubmodule(git$, tmpDir, submoduleRepoPath, 'deps/sub-one');
      await $`${git$} add .gitmodules deps/sub-one`;
      await $`${git$} commit --no-verify -m ${'add submodule'}`;

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

      await $`${git$} -c user.name=${'Alice'} -c user.email=${'alice@example.com'} commit --no-verify --allow-empty -m ${'alice 1'}`;
      await $`${git$} -c user.name=${'Bob'} -c user.email=${'bob@example.com'} commit --no-verify --allow-empty -m ${'bob 1'}`;
      await $`${git$} -c user.name=${'Alice'} -c user.email=${'alice@example.com'} commit --no-verify --allow-empty -m ${'alice 2'}`;

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
      expect(buffer.stdout).toContain('Language Activity');
      expect(buffer.stdout).toContain('JavaScript');
      expect(buffer.stdout).toContain('━');
   });

   it('should render language usage from net lines (added - removed)', async () => {
      await seedLanguageCatalog();

      await fs.writeFile(path.join(tmpDir, 'balance.ts'), 'a\nb\nc\nd\n');
      await $`${git$} add balance.ts`;
      await $`${git$} -c user.name=${'Metric User'} -c user.email=${'metric@example.com'} commit --no-verify -m ${'add ts lines'}`;

      await fs.writeFile(path.join(tmpDir, 'balance.ts'), '');
      await fs.writeFile(path.join(tmpDir, 'net.js'), 'const now = true;\n');
      await $`${git$} add balance.ts net.js`;
      await $`${git$} -c user.name=${'Metric User'} -c user.email=${'metric@example.com'} commit --no-verify -m ${'remove ts and add js'}`;

      const netCtx = createGdxContext(tmpDir, [
         'stats',
         '--author',
         'metric@example.com',
         '--lang-metric',
         'net',
      ]);
      const result = await stats(netCtx);
      expect(result).toBe(0);
      expect(buffer.stdout).toContain('Language Usage');
      expect(buffer.stdout).toContain('JavaScript');
      expect(buffer.stdout).not.toContain('TypeScript');
   });

   it('should default language metric to activity for author scope and net for --all', async () => {
      await seedLanguageCatalog();

      await fs.writeFile(path.join(tmpDir, 'auto-mode.ts'), 'a\nb\nc\nd\n');
      await $`${git$} add auto-mode.ts`;
      await $`${git$} -c user.name=${'Auto User'} -c user.email=${'auto@example.com'} commit --no-verify -m ${'add auto-mode ts lines'}`;

      await fs.writeFile(path.join(tmpDir, 'auto-mode.ts'), '');
      await fs.writeFile(path.join(tmpDir, 'auto-mode.js'), 'const after = true;\n');
      await $`${git$} add auto-mode.ts auto-mode.js`;
      await $`${git$} -c user.name=${'Auto User'} -c user.email=${'auto@example.com'} commit --no-verify -m ${'replace ts with js in auto mode'}`;

      const authorCtx = createGdxContext(tmpDir, ['stats', '--author', 'auto@example.com']);
      const authorResult = await stats(authorCtx);
      expect(authorResult).toBe(0);
      expect(buffer.stdout).toContain('Language Activity');
      expect(buffer.stdout).toContain('TypeScript');

      buffer.stdout = '';
      const allCtx = createGdxContext(tmpDir, ['stats', '--all']);
      const allResult = await stats(allCtx);
      expect(allResult).toBe(0);
      expect(buffer.stdout).toContain('Language Usage');
   });

   it('should allow overriding language metric mode', async () => {
      await seedLanguageCatalog();

      await fs.writeFile(path.join(tmpDir, 'override.ts'), 'a\nb\nc\nd\n');
      await $`${git$} add override.ts`;
      await $`${git$} -c user.name=${'Override User'} -c user.email=${'override@example.com'} commit --no-verify -m ${'add override ts lines'}`;

      await fs.writeFile(path.join(tmpDir, 'override.ts'), '');
      await fs.writeFile(path.join(tmpDir, 'override.js'), 'const after = true;\n');
      await $`${git$} add override.ts override.js`;
      await $`${git$} -c user.name=${'Override User'} -c user.email=${'override@example.com'} commit --no-verify -m ${'replace ts with js in override mode'}`;

      const allActivityCtx = createGdxContext(tmpDir, [
         'stats',
         '--all',
         '--lang-metric',
         'activity',
      ]);
      const allActivityResult = await stats(allActivityCtx);
      expect(allActivityResult).toBe(0);
      expect(buffer.stdout).toContain('Language Activity');
      expect(buffer.stdout).toContain('TypeScript');

      buffer.stdout = '';
      const authorNetCtx = createGdxContext(tmpDir, [
         'stats',
         '--author',
         'override@example.com',
         '--lang-metric',
         'net',
      ]);
      const authorNetResult = await stats(authorNetCtx);
      expect(authorNetResult).toBe(0);
      expect(buffer.stdout).toContain('Language Usage');
      expect(buffer.stdout).toContain('JavaScript');
      expect(buffer.stdout).not.toContain('TypeScript');
   });

   it('should fail for invalid --lang-metric values', async () => {
      await seedLanguageCatalog();
      const invalidCtx = createGdxContext(tmpDir, ['stats', '--lang-metric', 'wrong']);
      const invalidResult = await stats(invalidCtx);
      expect(invalidResult).toBe(1);
      expect(buffer.stderr).toContain('Invalid --lang-metric value');

      const missingValueCtx = createGdxContext(tmpDir, ['stats', '--lang-metric']);
      const missingValueResult = await stats(missingValueCtx);
      expect(missingValueResult).toBe(1);
      expect(buffer.stderr).toContain('Invalid --lang-metric value');
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
         await $`${git$} commit --no-verify -m ${'offline lang catalog test'}`;

         const result = await stats(ctx);
         expect(result).toBe(0);
         expect(buffer.stdout).not.toContain('Language Activity');
         expect(buffer.stdout).not.toContain('Language Usage');
      } finally {
         globalThis.fetch = originalFetch;
         await seedLanguageCatalog();
      }
   });
});
