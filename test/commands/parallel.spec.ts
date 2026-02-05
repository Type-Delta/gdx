import { afterAll, describe, expect } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';

import parallel from '@/commands/parallel';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';
import { resetCache } from '@/common/cache';

describe('gdx parallel', async () => {
   const { tmpDir, tmpRootDir, $, buffer, cleanup, it, env, resetRepo } = await createTestEnv({
      autoResetBuffer: true,
   });
   const { git$ } = createGdxContext(tmpDir);
   afterAll(cleanup);

   it('should list empty worktrees initially', async () => {
      const listCtx = createGdxContext(tmpDir, ['parallel', 'list']);
      const result = await parallel(listCtx);

      expect(result).toBe(0);
      // LINK: dkn2ika string literal in spec
      expect(buffer.stdout.toLowerCase()).toContain('no forked worktrees found');
   });

   it('should fork a new worktree', async () => {
      // Need a commit to branch off
      await $`${git$} commit --allow-empty -m ${'Initial commit'}`;

      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', 'feature-1']);
      const result = await parallel(forkCtx);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain('feature-1');
      expect(buffer.stdout).toContain('created');

      // Verify directory exists
      // LINK: dkk2iia forked worktree path
      const worktreePath = path.join(
         tmpRootDir,
         'tmp',
         'worktrees',
         'project',
         'master',
         'feature-1'
      );
      const exists = await fs
         .stat(worktreePath)
         .then(() => true)
         .catch(() => false);
      expect(exists).toBe(true);
   });

   it('should list active worktrees', async () => {
      const listCtx = createGdxContext(tmpDir, ['parallel', 'list']);
      const result = await parallel(listCtx);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain('feature-1');
   });

   it('should fail to fork with invalid alias', async () => {
      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', 'invalid/name']);
      const result = await parallel(forkCtx);

      expect(result).toBe(1);
      // LINK: dwmal2m string literal in spec
      expect(buffer.stderr).toContain('contains invalid characters');
   });

   it('should remove a worktree', async () => {
      const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', 'feature-1']);
      const result = await parallel(removeCtx);

      expect(result).toBe(0);
      // LINK: dw2al2m string literal in spec
      expect(buffer.stdout.toLowerCase()).toContain('removed worktree');

      // Verify directory is gone
      const worktreePath = path.join(tmpDir, 'worktrees', path.basename(tmpDir), 'feature-1');
      const exists = await fs
         .stat(worktreePath)
         .then(() => true)
         .catch(() => false);
      expect(exists).toBe(false);
   });

   it('should block removal when submodules are dirty', async () => {
      resetCache();
      const submoduleRoot = path.join(tmpRootDir, 'submodule');
      await fs.mkdir(submoduleRoot, { recursive: true });
      await $`${git$} -C ${submoduleRoot} init`;
      await $`${git$} -C ${submoduleRoot} config user.name ${'Test User'}`;
      await $`${git$} -C ${submoduleRoot} config user.email ${'test@example.com'}`;
      await fs.writeFile(path.join(submoduleRoot, 'README.md'), 'submodule');
      await $`${git$} -C ${submoduleRoot} add README.md`;
      await $`${git$} -C ${submoduleRoot} commit -m ${'init submodule'}`;

      const submoduleSha = (await $`${git$} -C ${submoduleRoot} rev-parse HEAD`).stdout.trim();
      const submoduleUrl = submoduleRoot.replace(/\\/g, '/');
      const gitmodulesContent = `[submodule "deps/submodule"]\n\tpath = deps/submodule\n\turl = ${submoduleUrl}\n`;
      await fs.writeFile(path.join(tmpDir, '.gitmodules'), gitmodulesContent);
      await $`${git$} -C ${tmpDir} add .gitmodules`;
      await $`${git$} -C ${tmpDir} update-index --add --cacheinfo 160000 ${submoduleSha} ${'deps/submodule'}`;
      await $`${git$} -C ${tmpDir} commit -m ${'Add submodule'}`;

      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', 'feature-submodule']);
      expect(await parallel(forkCtx)).toBe(0);

      const worktreeRoot = path.join(tmpRootDir, 'tmp', 'worktrees', 'project', 'master');
      const forkPath = path.join(worktreeRoot, 'feature-submodule');
      const submodulePath = path.join(forkPath, 'deps', 'submodule');
      const submoduleExists = await fs
         .stat(submodulePath)
         .then(() => true)
         .catch(() => false);
      if (!submoduleExists) {
         await fs.mkdir(path.join(forkPath, 'deps'), { recursive: true });
         await $`${git$} -C ${forkPath} -c protocol.file.allow=always clone ${submoduleRoot} ${'deps/submodule'}`;
      }
      await fs.writeFile(path.join(submodulePath, 'dirty.txt'), 'dirty');

      resetCache();
      const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', 'feature-submodule']);
      const removeResult = await parallel(removeCtx);

      expect(removeResult).toBe(1);
      expect(buffer.stderr).toContain('dirty submodules');

      await $`${git$} worktree prune --expire now`;
      await fs.rm(forkPath, { recursive: true, force: true });
      await resetRepo();
      await $`${git$} -C ${tmpDir} clean -fd`;
   });

   it('should prune missing worktree metadata on remove', async () => {
      resetCache();
      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', 'feature-prune']);
      expect(await parallel(forkCtx)).toBe(0);

      const worktreeRoot = path.join(tmpRootDir, 'tmp', 'worktrees', 'project', 'master');
      const forkPath = path.join(worktreeRoot, 'feature-prune');
      await fs.rm(forkPath, { recursive: true, force: true });

      resetCache();
      const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', 'feature-prune']);
      const removeResult = await parallel(removeCtx);

      expect(removeResult).toBe(0);
      expect(buffer.stdout.toLowerCase()).toContain('removed worktree metadata');

      const listOutput = (await $`${git$} worktree list --porcelain`).stdout;
      expect(listOutput).not.toContain(forkPath);
   });

   it('should join all worktrees recursively', async () => {
      const forkOneCtx = createGdxContext(tmpDir, ['parallel', 'fork', 'feature-1']);
      const forkTwoCtx = createGdxContext(tmpDir, ['parallel', 'fork', 'feature-2']);
      expect(await parallel(forkOneCtx)).toBe(0);
      expect(await parallel(forkTwoCtx)).toBe(0);

      const worktreeRoot = path.join(tmpRootDir, 'tmp', 'worktrees', 'project', 'master');
      const forkOnePath = path.join(worktreeRoot, 'feature-1');
      const forkTwoPath = path.join(worktreeRoot, 'feature-2');

      await fs.writeFile(path.join(forkOnePath, 'feature-one.txt'), 'one');
      await $`${git$} -C ${forkOnePath} add feature-one.txt`;
      await $`${git$} -C ${forkOnePath} commit -m ${'Add feature one'}`;

      await fs.writeFile(path.join(forkTwoPath, 'feature-two.txt'), 'two');
      await $`${git$} -C ${forkTwoPath} add feature-two.txt`;
      await $`${git$} -C ${forkTwoPath} commit -m ${'Add feature two'}`;

      const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', '-r']);
      const joinResult = await parallel(joinCtx);

      expect(joinResult).toBe(0);

      const featureOneExists = await fs
         .stat(path.join(tmpDir, 'feature-one.txt'))
         .then(() => true)
         .catch(() => false);
      const featureTwoExists = await fs
         .stat(path.join(tmpDir, 'feature-two.txt'))
         .then(() => true)
         .catch(() => false);
      expect(featureOneExists).toBe(true);
      expect(featureTwoExists).toBe(true);

      const forkOneExists = await fs
         .stat(forkOnePath)
         .then(() => true)
         .catch(() => false);
      const forkTwoExists = await fs
         .stat(forkTwoPath)
         .then(() => true)
         .catch(() => false);
      expect(forkOneExists).toBe(false);
      expect(forkTwoExists).toBe(false);
   });

   it('should reject recursive join with alias', async () => {
      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', 'feature-1']);
      expect(await parallel(forkCtx)).toBe(0);

      const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', '-r', 'feature-1']);
      const joinResult = await parallel(joinCtx);

      expect(joinResult).toBe(1);
      expect(buffer.stderr).toContain('Recursive join does not accept an alias');
   });

   it('should reject recursive join with --all', async () => {
      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', 'feature-3']);
      expect(await parallel(forkCtx)).toBe(0);

      const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', '-r', '--all']);
      const joinResult = await parallel(joinCtx);

      expect(joinResult).toBe(1);
      expect(buffer.stderr).toContain('Recursive join does not support --all');
   });

   it('should stop on cherry-pick conflicts and print manual steps', async () => {
      env.isTTY = false;
      await $`${git$} commit --allow-empty -m ${'Base commit'}`;

      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', 'feature-conflict']);
      expect(await parallel(forkCtx)).toBe(0);

      const worktreeRoot = path.join(tmpRootDir, 'tmp', 'worktrees', 'project', 'master');
      const forkPath = path.join(worktreeRoot, 'feature-conflict');

      await fs.writeFile(path.join(tmpDir, 'conflict.txt'), 'origin-change');
      await $`${git$} -C ${tmpDir} add conflict.txt`;
      await $`${git$} -C ${tmpDir} commit -m ${'Origin change'}`;

      await fs.writeFile(path.join(forkPath, 'conflict.txt'), 'fork-change');
      await $`${git$} -C ${forkPath} add conflict.txt`;
      await $`${git$} -C ${forkPath} commit -m ${'Fork change'}`;

      const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', 'feature-conflict']);
      const joinResult = await parallel(joinCtx);

      expect(joinResult).toBe(1);
      expect(buffer.stdout).toContain('cherry-pick --continue');

      const cherryPickHead = await $`${git$} -C ${tmpDir} rev-parse -q --verify CHERRY_PICK_HEAD`;
      expect(cherryPickHead.exitCode).toBe(0);
      env.isTTY = true;
   });
});
