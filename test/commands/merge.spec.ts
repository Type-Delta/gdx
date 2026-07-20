import { describe, expect } from 'bun:test';
import path from 'path';

import * as fs from '@/modules/fs';
import { dispatch } from '@/cli/dispatch';
import { resetCache } from '@/common/cache';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';

interface MergeWorktreeInfo {
   alias: string;
   path: string;
   meta: {
      purpose?: string;
      targetBranch?: string;
      mergeArgs?: string[];
   };
}

describe('gdx merge', async () => {
   const { tmpDir, tmpRootDir, $, buffer, it, resetRepo } = await createTestEnv({
      autoResetBuffer: true,
      suitName: 'merge',
   });
   const { git$ } = createGdxContext(tmpDir);
   const gitExec = Array.isArray(git$) ? git$[0] : git$;

   async function resetFixture(): Promise<void> {
      await resetRepo('full');
      await fs.rm(path.join(tmpRootDir, 'tmp', 'worktrees'), {
         recursive: true,
         force: true,
      });
      await fs.rm(path.join(tmpRootDir, 'existing-worktrees'), {
         recursive: true,
         force: true,
      });
      resetCache();
   }

   async function commitFile(fileName: string, content: string, message: string): Promise<string> {
      fs.writeFileSync(path.join(tmpDir, fileName), content);
      await $`${git$} add ${fileName}`;
      await $`${git$} commit --no-verify -m ${message}`;
      return (await $`${git$} rev-parse HEAD`).stdout.trim();
   }

   function readMergeWorktrees(): MergeWorktreeInfo[] {
      const worktreeRoot = path.join(tmpRootDir, 'tmp', 'worktrees');
      if (!fs.existsSync(worktreeRoot)) return [];

      const result: MergeWorktreeInfo[] = [];
      const visit = (dir: string) => {
         for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const child = path.join(dir, entry.name);
            if (!entry.isDirectory()) continue;

            const metaPath = path.join(child, '.git-parallel.json');
            if (fs.existsSync(metaPath)) {
               const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as MergeWorktreeInfo['meta'];
               if (meta.purpose === 'merge-target') {
                  result.push({ alias: entry.name, path: child, meta });
               }
               continue;
            }

            visit(child);
         }
      };

      visit(worktreeRoot);
      return result;
   }

   async function waitForPathRemoved(targetPath: string): Promise<boolean> {
      for (let attempt = 0; attempt < 100; attempt++) {
         if (!fs.existsSync(targetPath)) return true;
         await Bun.sleep(50);
      }
      return !fs.existsSync(targetPath);
   }

   async function createExistingWorktree(branch: string, alias: string): Promise<string> {
      const worktreePath = path.join(tmpRootDir, 'existing-worktrees', alias);
      fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
      await $`${git$} worktree add ${worktreePath} ${branch}`;
      return worktreePath;
   }

   async function removeExistingWorktree(worktreePath: string): Promise<void> {
      try {
         await $`${git$} worktree remove --force ${worktreePath}`;
      } catch {
         // The test reset path also removes the directory; this is best-effort cleanup.
      }
      try {
         await $`${git$} worktree prune --expire now`;
      } catch {
         // Best-effort cleanup for stale worktree metadata.
      }
      await fs.rm(worktreePath, { recursive: true, force: true });
   }

   it('fast-forwards a target branch without creating a worktree', async () => {
      await resetFixture();
      await $`${git$} branch target-ff`;
      const sourceHead = await commitFile('ff.txt', 'ff', 'Add fast-forward source');

      const result = await dispatch(createGdxContext(tmpDir, ['merge', 'master', '--target', 'target-ff']));

      const targetHead = (await $`${git$} rev-parse target-ff`).stdout.trim();
      const currentBranch = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();

      expect(result).toBe(0);
      expect(targetHead).toBe(sourceHead);
      expect(currentBranch).toBe('master');
      expect(readMergeWorktrees()).toEqual([]);
   });

   it('delegates signature verification to Git instead of directly fast-forwarding', async () => {
      await resetFixture();
      await $`${git$} branch target-verify-signatures`;
      await commitFile('unsigned.txt', 'unsigned', 'Add unsigned source');
      const targetBefore = (await $`${git$} rev-parse target-verify-signatures`).stdout.trim();

      const result = await dispatch(
         createGdxContext(tmpDir, [
            'merge',
            'master',
            '--verify-signatures',
            '--target',
            'target-verify-signatures',
         ])
      );
      const targetAfter = (await $`${git$} rev-parse target-verify-signatures`).stdout.trim();

      expect(result).not.toBe(0);
      expect(targetAfter).toBe(targetBefore);
      expect(readMergeWorktrees()).toEqual([]);
   });

   it('preserves a successful no-commit merge for continuation', async () => {
      await resetFixture();
      await $`${git$} branch target-no-commit`;
      await commitFile('no-commit-source.txt', 'source', 'Add no-commit source');

      await $`${git$} switch target-no-commit`;
      const targetBefore = await commitFile('no-commit-target.txt', 'target', 'Add no-commit target');
      await $`${git$} switch master`;

      const result = await dispatch(
         createGdxContext(tmpDir, [
            'merge',
            'master',
            '--no-commit',
            '--target',
            'target-no-commit',
         ])
      );
      const [worktree] = readMergeWorktrees();
      const targetAfter = (await $`${git$} rev-parse target-no-commit`).stdout.trim();
      const mergeHead = (
         await $`${gitExec} -C ${worktree.path} rev-parse -q --verify MERGE_HEAD`
      ).stdout.trim();

      expect(result).toBe(0);
      expect(targetAfter).toBe(targetBefore);
      expect(worktree).toBeDefined();
      expect(mergeHead).not.toBe('');
      expect(buffer.stdout).toContain('merge --continue');

      const abortResult = await dispatch(createGdxContext(worktree.path, ['merge', '--abort']));
      expect(abortResult).toBe(0);
      expect(await waitForPathRemoved(worktree.path)).toBe(true);
   });

   it('preserves squash changes for an explicit commit', async () => {
      await resetFixture();
      await $`${git$} branch target-squash`;
      await commitFile('squash-source.txt', 'source', 'Add squash source');

      await $`${git$} switch target-squash`;
      const targetBefore = await commitFile('squash-target.txt', 'target', 'Add squash target');
      await $`${git$} switch master`;

      const result = await dispatch(
         createGdxContext(tmpDir, ['merge', 'master', '--squash', '--target', 'target-squash'])
      );
      const [worktree] = readMergeWorktrees();
      const targetAfterMerge = (await $`${git$} rev-parse target-squash`).stdout.trim();
      const status = (await $`${gitExec} -C ${worktree.path} status --porcelain=v1`).stdout;

      expect(result).toBe(0);
      expect(targetAfterMerge).toBe(targetBefore);
      expect(worktree).toBeDefined();
      expect(status).toContain('squash-source.txt');
      expect(buffer.stdout).toContain('review and commit');

      await $`${gitExec} -C ${worktree.path} commit --no-verify -m ${'Commit squashed source'}`;
      const removeResult = await dispatch(
         createGdxContext(tmpDir, ['parallel', 'remove', worktree.alias])
      );

      expect(removeResult).toBe(0);
      expect(await waitForPathRemoved(worktree.path)).toBe(true);
   });

   it('runs the merge in an existing worktree when the target branch is checked out there', async () => {
      await resetFixture();
      await $`${git$} branch target-existing`;
      const targetWorktree = await createExistingWorktree('target-existing', 'target-existing');

      try {
         const sourceHead = await commitFile('existing-ff.txt', 'existing', 'Existing worktree source');

         const result = await dispatch(
            createGdxContext(tmpDir, ['merge', 'master', '--target', 'target-existing'])
         );

         const targetHead = (await $`${git$} -C ${targetWorktree} rev-parse HEAD`).stdout.trim();
         const targetContent = fs.readFileSync(path.join(targetWorktree, 'existing-ff.txt'), 'utf-8');
         const currentBranch = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();

         expect(result).toBe(0);
         expect(targetHead).toBe(sourceHead);
         expect(targetContent).toBe('existing');
         expect(currentBranch).toBe('master');
         expect(readMergeWorktrees()).toEqual([]);
      } finally {
         await removeExistingWorktree(targetWorktree);
      }
   });

   it('continues a conflicted merge in an existing target worktree', async () => {
      await resetFixture();
      await $`${git$} branch target-existing-conflict`;
      fs.writeFileSync(path.join(tmpDir, 'existing-conflict.txt'), 'source\n');
      await $`${git$} add existing-conflict.txt`;
      await $`${git$} commit --no-verify -m ${'Existing source conflict'}`;

      await $`${git$} switch target-existing-conflict`;
      fs.writeFileSync(path.join(tmpDir, 'existing-conflict.txt'), 'target\n');
      await $`${git$} add existing-conflict.txt`;
      await $`${git$} commit --no-verify -m ${'Existing target conflict'}`;
      await $`${git$} switch master`;

      const targetWorktree = await createExistingWorktree(
         'target-existing-conflict',
         'target-existing-conflict'
      );

      try {
         const result = await dispatch(
            createGdxContext(tmpDir, [
               'merge',
               '--no-edit',
               'master',
               '--target',
               'target-existing-conflict',
            ])
         );
         const mergeHead = (
            await $`${git$} -C ${targetWorktree} rev-parse -q --verify MERGE_HEAD`
         ).stdout.trim();

         expect(result).toBe(1);
         expect(mergeHead).not.toBe('');
         expect(buffer.stdout).not.toContain('gdx parallel switch');
         expect(readMergeWorktrees()).toEqual([]);

         fs.writeFileSync(path.join(targetWorktree, 'existing-conflict.txt'), 'resolved-existing\n');
         await $`${git$} -C ${targetWorktree} add existing-conflict.txt`;
         await $`${git$} -C ${targetWorktree} config core.editor true`;

         buffer.stdout = '';
         const continueResult = await dispatch(
            createGdxContext(tmpDir, [
               'merge',
               '--continue',
               '--target',
               'target-existing-conflict',
            ])
         );
         const targetContent = (
            await $`${git$} show target-existing-conflict:existing-conflict.txt`
         ).stdout;

         expect(continueResult).toBe(0);
         expect(targetContent).toBe('resolved-existing');
         expect(fs.existsSync(targetWorktree)).toBe(true);
      } finally {
         await removeExistingWorktree(targetWorktree);
      }
   });

   it('aborts a conflicted merge in an existing target worktree', async () => {
      await resetFixture();
      await $`${git$} branch target-existing-abort`;
      fs.writeFileSync(path.join(tmpDir, 'existing-abort.txt'), 'source\n');
      await $`${git$} add existing-abort.txt`;
      await $`${git$} commit --no-verify -m ${'Existing source abort conflict'}`;

      await $`${git$} switch target-existing-abort`;
      fs.writeFileSync(path.join(tmpDir, 'existing-abort.txt'), 'target\n');
      await $`${git$} add existing-abort.txt`;
      await $`${git$} commit --no-verify -m ${'Existing target abort conflict'}`;
      const targetBeforeAbort = (await $`${git$} rev-parse HEAD`).stdout.trim();
      await $`${git$} switch master`;

      const targetWorktree = await createExistingWorktree(
         'target-existing-abort',
         'target-existing-abort'
      );

      try {
         const result = await dispatch(
            createGdxContext(tmpDir, [
               'merge',
               '--no-edit',
               'master',
               '--target',
               'target-existing-abort',
            ])
         );
         const mergeHead = (
            await $`${git$} -C ${targetWorktree} rev-parse -q --verify MERGE_HEAD`
         ).stdout.trim();

         expect(result).toBe(1);
         expect(mergeHead).not.toBe('');
         expect(readMergeWorktrees()).toEqual([]);

         buffer.stdout = '';
         const abortResult = await dispatch(
            createGdxContext(tmpDir, ['merge', '--abort', '--target', 'target-existing-abort'])
         );
         const targetAfterAbort = (await $`${git$} rev-parse target-existing-abort`).stdout.trim();

         expect(abortResult).toBe(0);
         expect(targetAfterAbort).toBe(targetBeforeAbort);
         expect(fs.existsSync(targetWorktree)).toBe(true);
      } finally {
         await removeExistingWorktree(targetWorktree);
      }
   });

   it('leaves conflicts in a registered no-init worktree and continues after resolution', async () => {
      await resetFixture();
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.env\n');
      fs.writeFileSync(path.join(tmpDir, '.env'), 'secret');
      await $`${git$} add .gitignore`;
      await $`${git$} commit --no-verify -m ${'Ignore env'}`;
      await $`${git$} branch target-conflict`;

      fs.writeFileSync(path.join(tmpDir, 'conflict.txt'), 'source\n');
      await $`${git$} add conflict.txt`;
      await $`${git$} commit --no-verify -m ${'Source conflict'}`;

      await $`${git$} switch target-conflict`;
      fs.writeFileSync(path.join(tmpDir, 'conflict.txt'), 'target\n');
      await $`${git$} add conflict.txt`;
      await $`${git$} commit --no-verify -m ${'Target conflict'}`;
      await $`${git$} switch master`;

      const result = await dispatch(
         createGdxContext(tmpDir, ['merge', '--no-edit', 'master', '--target', 'target-conflict'])
      );
      const mergeWorktrees = readMergeWorktrees();

      expect(result).toBe(1);
      expect(buffer.stdout).toContain('gdx parallel switch');
      expect(mergeWorktrees).toHaveLength(1);
      expect(mergeWorktrees[0].meta.targetBranch).toBe('target-conflict');
      expect(fs.existsSync(path.join(mergeWorktrees[0].path, '.env'))).toBe(false);

      const worktree = mergeWorktrees[0];
      fs.writeFileSync(path.join(worktree.path, 'conflict.txt'), 'resolved\n');
      await $`${gitExec} -C ${worktree.path} add conflict.txt`;
      await $`${gitExec} -C ${worktree.path} config core.editor true`;

      buffer.stdout = '';
      const continueResult = await dispatch(createGdxContext(worktree.path, ['merge', '--continue']));
      const targetContent = (await $`${git$} show target-conflict:conflict.txt`).stdout;

      expect(continueResult).toBe(0);
      expect(targetContent).toBe('resolved');
      expect(await waitForPathRemoved(worktree.path)).toBe(true);
   });

   it('lets parallel remove discard a conflicted merge worktree', async () => {
      await resetFixture();
      await $`${git$} branch target-remove`;
      fs.writeFileSync(path.join(tmpDir, 'remove-conflict.txt'), 'source\n');
      await $`${git$} add remove-conflict.txt`;
      await $`${git$} commit --no-verify -m ${'Source remove conflict'}`;

      await $`${git$} switch target-remove`;
      fs.writeFileSync(path.join(tmpDir, 'remove-conflict.txt'), 'target\n');
      await $`${git$} add remove-conflict.txt`;
      await $`${git$} commit --no-verify -m ${'Target remove conflict'}`;
      await $`${git$} switch master`;

      const result = await dispatch(
         createGdxContext(tmpDir, ['merge', '--no-edit', 'master', '--target', 'target-remove'])
      );
      const [worktree] = readMergeWorktrees();

      expect(result).toBe(1);
      expect(worktree).toBeDefined();

      buffer.stdout = '';
      const removeResult = await dispatch(
         createGdxContext(tmpDir, ['parallel', 'remove', worktree.alias])
      );

      expect(removeResult).toBe(0);
      expect(await waitForPathRemoved(worktree.path)).toBe(true);
   });

   it('aborts and removes a merge-target worktree', async () => {
      await resetFixture();
      await $`${git$} branch target-abort`;
      fs.writeFileSync(path.join(tmpDir, 'abort-conflict.txt'), 'source\n');
      await $`${git$} add abort-conflict.txt`;
      await $`${git$} commit --no-verify -m ${'Source abort conflict'}`;

      await $`${git$} switch target-abort`;
      fs.writeFileSync(path.join(tmpDir, 'abort-conflict.txt'), 'target\n');
      await $`${git$} add abort-conflict.txt`;
      await $`${git$} commit --no-verify -m ${'Target abort conflict'}`;
      const targetBeforeAbort = (await $`${git$} rev-parse HEAD`).stdout.trim();
      await $`${git$} switch master`;

      const result = await dispatch(
         createGdxContext(tmpDir, ['merge', '--no-edit', 'master', '--target', 'target-abort'])
      );
      const [worktree] = readMergeWorktrees();

      expect(result).toBe(1);
      expect(worktree).toBeDefined();

      buffer.stdout = '';
      const abortResult = await dispatch(
         createGdxContext(tmpDir, ['merge', '--abort', '--target', 'target-abort'])
      );
      const targetAfterAbort = (await $`${git$} rev-parse target-abort`).stdout.trim();

      expect(abortResult).toBe(0);
      expect(targetAfterAbort).toBe(targetBeforeAbort);
      expect(await waitForPathRemoved(worktree.path)).toBe(true);
   });
});
