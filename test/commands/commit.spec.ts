import { describe, expect } from 'bun:test';
import fs from 'fs/promises';
import { mkdirSync } from 'fs';
import path from 'path';

import commit from '@/commands/commit';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';
import { getCache, resetCache } from '@/common/cache';
import { $ as shell$ } from '@/modules/shell';
import { commitMsgGenerator, commitMsgGeneratorInherent } from '@/templates/prompts';
import { getConfig } from '@/common/config';

async function clearRemotes($: typeof shell$): Promise<void> {
   const remotes = (await $`git remote`).stdout
      .trim()
      .split('\n')
      .map((remote: string) => remote.trim())
      .filter(Boolean);

   for (const remote of remotes) {
      await $`git remote remove ${remote}`;
   }
}

describe('gdx commit auto', async () => {
   // Set comprehensive mode via env var before creating test env
   process.env.GDX_COMMIT_PATTERN = 'comprehensive';

   const { tmpDir, $, buffer, it } = await createTestEnv({ suitName: 'commit-auto' });
   const ctx = createGdxContext(tmpDir, ['commit', 'auto']);
   const { git$ } = ctx;

   it('should fail if no staged changes', async () => {
      const result = await commit.auto(ctx);
      expect(result).toBe(1);
      expect(buffer.stdout).toContain('No staged changes found');
   });

   it('should generate commit message and commit', async () => {
      // Set dummy editor to simulate open and close action from user
      await $`${git$} config core.editor ${'bun run dummy-editor --'}`;

      // Create and stage a file
      await fs.writeFile(path.join(tmpDir, 'newfile.txt'), 'content');
      await $`${git$} add newfile.txt`;

      const result = await commit.auto(ctx);

      expect(result).toBe(0);

      // Verify commit was made
      const log = (await $`${git$} log -1 --pretty=%B`).stdout;
      expect(log).toContain('Mock response from LLM');
   });

   it('should respect --no-commit flag', async () => {
      // Modify file and stage
      await fs.writeFile(path.join(tmpDir, 'newfile.txt'), 'modified content');
      await $`${git$} add newfile.txt`;

      const ncCtx = createGdxContext(tmpDir, ['commit', 'auto', '--no-commit']);
      const result = await commit.auto(ncCtx);

      expect(result).toBe(0);

      // Verify NO commit was made (HEAD should be same as before)
      const status = (await $`${git$} status --porcelain`).stdout;
      expect(status).toContain('M  newfile.txt');
   });

   it('should commit immediately with --yes', async () => {
      // Modify file and stage
      await fs.writeFile(path.join(tmpDir, 'newfile.txt'), 'yes mode content');
      await $`${git$} add newfile.txt`;

      const yesCtx = createGdxContext(tmpDir, ['commit', 'auto', '--yes']);
      const result = await commit.auto(yesCtx);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain('Generated Commit Message');

      const log = (await $`${git$} log -1 --pretty=%B`).stdout;
      expect(log).toContain('Mock response from LLM');
   });

   it('should accept --describe and still commit successfully', async () => {
      await fs.writeFile(path.join(tmpDir, 'newfile.txt'), 'described content');
      await $`${git$} add newfile.txt`;

      const describedCtx = createGdxContext(tmpDir, [
         'commit',
         'auto',
         '--yes',
         '--describe',
         'refactor parser and trim noisy lockfile diffs',
      ]);
      const result = await commit.auto(describedCtx);

      expect(result).toBe(0);

      const log = (await $`${git$} log -1 --pretty=%B`).stdout;
      expect(log).toContain('Mock response from LLM');
   });

   it('should warn and ignore --yes when --no-commit is set', async () => {
      await fs.writeFile(path.join(tmpDir, 'newfile.txt'), 'ignored yes content');
      await $`${git$} add newfile.txt`;

      const noCommitYesCtx = createGdxContext(tmpDir, ['commit', 'auto', '--no-commit', '--yes']);
      const result = await commit.auto(noCommitYesCtx);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain('Generated Commit Message');
      expect(buffer.stdout).toContain('Ignoring --yes because --no-commit was requested.');

      const status = (await $`${git$} status --porcelain`).stdout;
      expect(status).toContain('M  newfile.txt');
   });

   it('should warn when --describe is provided without a value', async () => {
      await fs.writeFile(path.join(tmpDir, 'newfile.txt'), 'empty describe');
      await $`${git$} add newfile.txt`;

      const emptyDescribeCtx = createGdxContext(tmpDir, [
         'commit',
         'auto',
         '--no-commit',
         '--describe',
      ]);
      const result = await commit.auto(emptyDescribeCtx);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain(
         'Ignoring --describe/-d because no description text was provided.'
      );
   });

   it('should print prompt and exit when --preview is set', async () => {
      await fs.writeFile(path.join(tmpDir, 'newfile.txt'), 'preview content');
      await $`${git$} add newfile.txt`;

      const previewCtx = createGdxContext(tmpDir, ['commit', 'auto', '--preview']);
      const result = await commit.auto(previewCtx);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain('<git-diff>');

      const status = (await $`${git$} status --porcelain`).stdout;
      expect(status).toContain('M  newfile.txt');
   });

   it('should classify configured noisy glob patterns as noisy', async () => {
      const config = await getConfig();
      await config.set('commit.noisyFiles', ['**/*.generated.ts']);
      await config.save();

      await fs.writeFile(path.join(tmpDir, 'auto.generated.ts'), 'export const x = 1;\n', 'utf-8');
      await $`${git$} add auto.generated.ts`;

      const previewCtx = createGdxContext(tmpDir, ['commit', 'auto', '--preview']);
      const result = await commit.auto(previewCtx);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain('<noisy-text-diffs>');
      expect(buffer.stdout).toContain('auto.generated.ts');
   });
});

describe('gdx commit auto - inherit mode', async () => {
   // Use inherit mode for these tests
   process.env.GDX_COMMIT_PATTERN = 'inherit';

   const { tmpDir, tmpRootDir, $, buffer, it, resetRepo } = await createTestEnv({
      suitName: 'commit-auto-inherit'
   });
   const ctx = createGdxContext(tmpDir, ['commit', 'auto']);
   const { git$ } = ctx;

   it('should cache commit guidelines when repo has sufficient history', async () => {
      // Reset cache to ensure clean state
      resetCache();

      // Create multiple commits to build history
      for (let i = 0; i < 6; i++) {
         const filename = `history-${i}.txt`;
         await fs.writeFile(path.join(tmpDir, filename), `content ${i}`);
         await $`${git$} add ${filename}`;
         await $`${git$} commit -m ${'feat: add feature ' + i}`;
      }

      // Now create a new change and use commit auto
      await fs.writeFile(path.join(tmpDir, 'test-cache.txt'), 'test content');
      await $`${git$} add test-cache.txt`;

      // Set dummy editor
      await $`${git$} config core.editor ${'bun run dummy-editor --'}`;

      const result = await commit.auto(createGdxContext(tmpDir, ['commit', 'auto']));
      expect(result).toBe(0);

      // Check if guidelines were cached
      const cache = await getCache();
      const allCache = await cache.getAll();

      // Look for a cache entry under commit key
      const cacheData = JSON.stringify(allCache.data);
      expect(cacheData).toContain('repoGuidelines');
   });

   it('should reuse guidelines cache across worktrees', async () => {
      await resetRepo();
      await clearRemotes($);
      resetCache();

      for (let i = 0; i < 6; i++) {
         const filename = `history-${i}.txt`;
         await fs.writeFile(path.join(tmpDir, filename), `content ${i}`);
         await $`${git$} add ${filename}`;
         await $`${git$} commit -m ${'feat: add feature ' + i}`;
      }

      await $`${git$} config core.editor ${'bun run dummy-editor --'}`;
      await fs.writeFile(path.join(tmpDir, 'cache-main.txt'), 'main worktree');
      await $`${git$} add cache-main.txt`;
      await commit.auto(createGdxContext(tmpDir, ['commit', 'auto']));

      const worktreeDir = path.join(tmpRootDir, 'worktree');
      await $`${git$} worktree add ${worktreeDir} -b ${'worktree-branch'}`;

      await fs.writeFile(path.join(worktreeDir, 'cache-worktree.txt'), 'worktree');
      await $`${git$} -C ${worktreeDir} add cache-worktree.txt`;
      await $`${git$} -C ${worktreeDir} config core.editor ${'bun run dummy-editor --'}`;

      const wtCtx = createGdxContext(worktreeDir, ['commit', 'auto']);
      const wtResult = await commit.auto(wtCtx);
      expect(wtResult).toBe(0);

      const cache = await getCache();
      const allCache = await cache.getAll();
      const guidelineKeys = Object.keys(allCache.entryMeta).filter((key) =>
         key.startsWith('commit.repoGuidelines.')
      );
      expect(guidelineKeys.length).toBe(1);
   });

   it('should share guidelines cache across ssh and https remotes', async () => {
      await resetRepo();
      await clearRemotes($);
      resetCache();

      const httpsRemote = 'https://github.com/example/acme.git';
      const sshRemote = 'git@github.com:example/acme.git';

      await $`${git$} remote add origin ${httpsRemote}`;

      for (let i = 0; i < 6; i++) {
         const filename = `history-${i}.txt`;
         await fs.writeFile(path.join(tmpDir, filename), `content ${i}`);
         await $`${git$} add ${filename}`;
         await $`${git$} commit -m ${'feat: add feature ' + i}`;
      }

      await $`${git$} config core.editor ${'bun run dummy-editor --'}`;
      await fs.writeFile(path.join(tmpDir, 'cache-remote.txt'), 'remote');
      await $`${git$} add cache-remote.txt`;
      await commit.auto(createGdxContext(tmpDir, ['commit', 'auto']));

      const otherDir = path.join(tmpRootDir, 'repo2');
      mkdirSync(otherDir, { recursive: true });
      const $other = shell$({ cwd: otherDir });

      await $other`git init`;
      await $other`git config user.name ${'Test User'}`;
      await $other`git config user.email ${'test@example.com'}`;
      await $other`git commit --allow-empty -m ${'Initial commit'}`;
      await $other`git remote add origin ${sshRemote}`;
      await $other`git config core.editor ${'bun run dummy-editor --'}`;

      for (let i = 0; i < 6; i++) {
         const filename = `history-${i}.txt`;
         await fs.writeFile(path.join(otherDir, filename), `content ${i}`);
         await $other`git add ${filename}`;
         await $other`git commit -m ${'feat: add feature ' + i}`;
      }

      await fs.writeFile(path.join(otherDir, 'cache-remote.txt'), 'remote');
      await $other`git add cache-remote.txt`;

      const otherCtx = createGdxContext(otherDir, ['commit', 'auto']);
      const otherResult = await commit.auto(otherCtx);
      expect(otherResult).toBe(0);

      const cache = await getCache();
      const allCache = await cache.getAll();
      const guidelineKeys = Object.keys(allCache.entryMeta).filter((key) =>
         key.startsWith('commit.repoGuidelines.')
      );
      expect(guidelineKeys.length).toBe(1);
   }, { timeout: 10000 });

   it('should fallback to comprehensive when history is insufficient', async () => {
      // The repo starts with 1 initial commit from createTestEnv
      // This is < 5, so it should warn and continue (not fallback to comprehensive)
      // Reset repo to initial state
      await resetRepo();

      // Clear all cache
      resetCache();

      // Stage a file
      await fs.writeFile(path.join(tmpDir, 'file.txt'), 'content');
      await $`${git$} add file.txt`;

      await $`${git$} config core.editor ${'bun run dummy-editor --'}`;
      const result = await commit.auto(createGdxContext(tmpDir, ['commit', 'auto']));

      // Should still succeed
      expect(result).toBe(0);

      // Should have warned about insufficient history
      // LINK: dii2ndk text literal in spec
      expect(buffer.stdout).toContain('less accurate');

      // Verify commit was made even with fallback
      const log = (await $`${git$} log -1 --pretty=%B`).stdout;
      expect(log).toContain('Mock response from LLM');
   });
});

describe('commit prompt templates', async () => {
   const { it } = await createTestEnv({ liteMode: true, suitName: 'commit-prompts' });

   it('should include user description block in comprehensive prompt', () => {
      const prompt = commitMsgGenerator('summary content', 'tighten diff summarization logic');
      expect(prompt).toContain('User describes the changes as: tighten diff summarization logic');
   });

   it('should omit user description block when description is not provided', () => {
      const prompt = commitMsgGenerator('summary content');
      expect(prompt).not.toContain('User describes the changes as:');
   });

   it('should include user description block in inherit prompt', () => {
      const prompt = commitMsgGeneratorInherent(
         'summary content',
         'Use emoji + conventional commits',
         'improve prompt relevance'
      );
      expect(prompt).toContain('User describes the changes as: improve prompt relevance');
   });
});
