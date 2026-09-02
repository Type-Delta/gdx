import { describe, expect } from 'bun:test';
import path from 'path';

import * as fs from '@/modules/fs';
import { addSubmodule, updateSubmodules } from '@/modules/git';
import { createGdxContext, createTestEnv, setTestGitConfig } from '@/utils/testHelper';
import { resetCache } from '@/common/cache';
import { resetConfig } from '@/common/config';
import { normalizePath } from '@/utils/utilities';
import { stripAnsiColor } from '@/modules/graphics';
import { asUnixPath } from '@/utils/path';
import { ArgsSet, stripGitGlobalArgs } from '@/modules/arguments';

function getParallelForkPath(
   tmpRootDir: string,
   repoPath: string,
   alias: string,
   branchName: string
): string {
   const projectName = path.basename(repoPath);
   return path.join(
      tmpRootDir,
      'tmp',
      'worktrees',
      normalizePath(projectName),
      normalizePath(branchName),
      alias
   );
}

function isSubmoduleRemovalBlockedError(stderr: string): boolean {
   const normalized = stripAnsiColor(stderr).toLowerCase();
   return (
      normalized.includes('dirty submodules') ||
      normalized.includes('must be deinitialized before removal')
   );
}

describe('gdx parallel', async () => {
   const { tmpDir, tmpRootDir, $, buffer, it, env, resetRepo, tracker } = await createTestEnv({
      autoResetBuffer: true,
      suitName: 'parallel'
   });
   const { git$ } = createGdxContext(tmpDir);
   const { default: parallel } = await import('@/commands/parallel');
   const { GDX_RESULT_FILE } = await import('@/consts');

   async function forceRemoveWorktreePath(worktreePath: string): Promise<void> {
      const gitExe = Array.isArray(git$) ? git$[0] : git$;
      try {
         await $`${gitExe} -C ${tmpDir} worktree remove --force ${worktreePath}`;
      } catch {
         // Best-effort cleanup for native submodule mode.
      }

      try {
         await $`${gitExe} -C ${tmpDir} worktree prune --expire now`;
      } catch {
         // Best-effort cleanup for stale metadata.
      }

      await fs.rm(worktreePath, { recursive: true, force: true });
   }

   async function createAdvancedOriginSubmoduleFork(alias: string) {
      const gitExe = Array.isArray(git$) ? git$[0] : git$;
      const submoduleRoot = path.join(tmpRootDir, `${alias}-source`);
      const submodulePath = `deps/${alias}`;
      fs.mkdirSync(submoduleRoot, { recursive: true });
      await $`${gitExe} -C ${submoduleRoot} init`;
      await setTestGitConfig(submoduleRoot, 'user.name', 'Test User');
      await setTestGitConfig(submoduleRoot, 'user.email', 'test@example.com');
      fs.writeFileSync(path.join(submoduleRoot, 'base.txt'), 'base\n');
      await $`${gitExe} -C ${submoduleRoot} add base.txt`;
      await $`${gitExe} -C ${submoduleRoot} commit --no-verify -m ${'Initial submodule commit'}`;

      await addSubmodule(git$, tmpDir, asUnixPath(submoduleRoot), submodulePath);
      await $`${gitExe} -C ${tmpDir} add .gitmodules ${submodulePath}`;
      await $`${gitExe} -C ${tmpDir} commit --no-verify -m ${'Add advanced submodule'}`;

      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias]);
      expect(await parallel(forkCtx)).toBe(0);
      const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
      const forkPath = getParallelForkPath(tmpRootDir, tmpDir, alias, branchName);
      await updateSubmodules(git$, forkPath, { recursive: true });

      fs.writeFileSync(path.join(forkPath, 'unrelated-fork.txt'), 'fork\n');
      await $`${gitExe} -C ${forkPath} add unrelated-fork.txt`;
      await $`${gitExe} -C ${forkPath} commit --no-verify -m ${'Unrelated fork commit'}`;

      fs.writeFileSync(path.join(submoduleRoot, 'origin-advance.txt'), 'advanced\n');
      await $`${gitExe} -C ${submoduleRoot} add origin-advance.txt`;
      await $`${gitExe} -C ${submoduleRoot} commit --no-verify -m ${'Advance origin submodule'}`;
      const advancedHead = (await $`${gitExe} -C ${submoduleRoot} rev-parse HEAD`).stdout.trim();

      const originSubmodulePath = path.join(tmpDir, submodulePath);
      await $`${gitExe} -C ${originSubmodulePath} fetch --quiet ${asUnixPath(submoduleRoot)} ${advancedHead}`;
      await $`${gitExe} -C ${originSubmodulePath} checkout --quiet --detach ${advancedHead}`;
      await $`${gitExe} -C ${tmpDir} add ${submodulePath}`;
      await $`${gitExe} -C ${tmpDir} commit --no-verify -m ${'Advance origin gitlink'}`;

      return {
         advancedHead,
         forkPath,
         forkSubmodulePath: path.join(forkPath, submodulePath),
         originSubmodulePath,
         submodulePath,
      };
   }

   async function createPendingJoinStash(alias: string) {
      fs.writeFileSync(path.join(tmpDir, `${alias}.txt`), 'base\n');
      await $`${git$} add ${`${alias}.txt`}`;
      await $`${git$} commit --no-verify -m ${'Pending stash base'}`;

      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias, '--no-init']);
      expect(await parallel(forkCtx)).toBe(0);
      const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
      const forkPath = getParallelForkPath(tmpRootDir, tmpDir, alias, branchName);

      fs.writeFileSync(path.join(forkPath, `${alias}.txt`), 'fork\n');
      await $`${git$} -C ${forkPath} add ${`${alias}.txt`}`;
      await $`${git$} -C ${forkPath} commit --no-verify -m ${'Pending stash fork'}`;
      fs.writeFileSync(path.join(forkPath, `${alias}-pending.txt`), 'pending\n');
      await $`${git$} -C ${forkPath} add ${`${alias}-pending.txt`}`;

      fs.writeFileSync(path.join(tmpDir, `${alias}.txt`), 'origin\n');
      await $`${git$} add ${`${alias}.txt`}`;
      await $`${git$} commit --no-verify -m ${'Pending stash origin'}`;

      const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', alias, '--all']);
      expect(await parallel(joinCtx)).toBe(1);
      const metaPath = path.join(forkPath, '.git-parallel.json');
      const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as {
         pendingJoinStash?: string;
      };
      expect(metadata.pendingJoinStash).toBeTruthy();

      return { forkPath, metaPath };
   }

   it('should list empty worktrees initially', async () => {
      resetCache();
      const listCtx = createGdxContext(tmpDir, ['parallel', 'ls', '-s']);
      const result = await parallel(listCtx);

      expect(result).toBe(0);
      // LINK: dkn2ika string literal in spec
      expect(buffer.stdout.toLowerCase()).toContain('no forked worktrees found');
   });

   it('should refresh discovery after repository initialization and branch changes', async () => {
      const cacheRepoDir = path.join(tmpRootDir, 'parallel-cache-repo');
      await fs.rm(cacheRepoDir, { recursive: true, force: true });
      fs.mkdirSync(cacheRepoDir, { recursive: true });

      try {
         const cacheRepoCtx = createGdxContext(cacheRepoDir, ['parallel', 'list']);
         expect(await parallel(cacheRepoCtx)).toBe(1);

         const gitExe = Array.isArray(git$) ? git$[0] : git$;
         await $`${gitExe} -C ${cacheRepoDir} init`;

         buffer.stdout = '';
         expect(await parallel(cacheRepoCtx)).toBe(0);
         expect(buffer.stdout).toContain('Project: parallel-cache-repo');

         await setTestGitConfig(cacheRepoDir, 'user.name', 'Test User');
         await setTestGitConfig(cacheRepoDir, 'user.email', 'test@example.com');
         await $`${gitExe} -C ${cacheRepoDir} commit --allow-empty --no-verify -m ${'Initial commit'}`;
         const initialBranch = (
            await $`${gitExe} -C ${cacheRepoDir} symbolic-ref --short HEAD`
         ).stdout.trim();

         await $`${gitExe} -C ${cacheRepoDir} checkout -b feature-cache`;
         buffer.stdout = '';
         expect(await parallel(cacheRepoCtx)).toBe(0);
         expect(buffer.stdout).toContain('Branch: feature-cache');

         await $`${gitExe} -C ${cacheRepoDir} checkout ${initialBranch}`;
         buffer.stdout = '';
         expect(await parallel(cacheRepoCtx)).toBe(0);
         expect(buffer.stdout).toContain(`Branch: ${initialBranch}`);
      } finally {
         await fs.rm(cacheRepoDir, { recursive: true, force: true });
      }
   });

   it('should show correct list headers in origin', async () => {
      const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
      const projectName = path.basename(tmpDir);

      const listCtx = createGdxContext(tmpDir, ['parallel', 'list']);
      const result = await parallel(listCtx);

      const output = asUnixPath(buffer.stdout);

      // LINK: iin2ya string literal in spec
      expect(result).toBe(0);
      expect(output).toContain(`Project: ${projectName}`);
      expect(output).toContain(`Branch: ${branchName}`);
      expect(output).toContain(`Origin: ${asUnixPath(tmpDir)}`);
      expect(output).toMatch(/Current:\s+origin\b/);
   });

   it('should fork a new worktree', async () => {
      // Need a commit to branch off
      await $`${git$} commit --allow-empty --no-verify -m ${'Initial commit'}`;

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

   it('should copy env files from .gitignore and envPaths', async () => {
      const configPath = process.env.GDX_CONFIG_PATH || '';
      const originalConfig = await fs.readFile(configPath, 'utf-8').catch(() => '');

      fs.writeFileSync(path.join(tmpDir, '.env'), 'env');
      fs.writeFileSync(path.join(tmpDir, '.env.local'), 'env-local');
      fs.writeFileSync(path.join(tmpDir, 'notes.txt'), 'notes');
      fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'config', 'app.env'), 'config-env');
      fs.mkdirSync(path.join(tmpDir, 'secrets', 'nested'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'secrets', 'token.txt'), 'token');
      fs.writeFileSync(path.join(tmpDir, 'secrets', 'nested', 'inner.txt'), 'inner');
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.env\n# comment\nnotes*.txt\n');
      await $`${git$} -C ${tmpDir} add .gitignore`;
      await $`${git$} -C ${tmpDir} commit --no-verify -m ${'Add gitignore for env'} `;

      fs.writeFileSync(
         configPath,
         '[parallel]\ninit = "env"\nenvPaths = ".env.local:config/*.env:secrets"\n',
         'utf-8'
      );

      resetConfig();
      resetCache();

      try {
         const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', 'feature-env']);
         expect(await parallel(forkCtx)).toBe(0);

         const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
         const projectName = path.basename(tmpDir);
         const worktreeRoot = path.join(
            tmpRootDir,
            'tmp',
            'worktrees',
            normalizePath(projectName),
            normalizePath(branchName)
         );
         const forkPath = path.join(worktreeRoot, 'feature-env');

         const envExists = await fs
            .stat(path.join(forkPath, '.env'))
            .then(() => true)
            .catch(() => false);
         const envLocalExists = await fs
            .stat(path.join(forkPath, '.env.local'))
            .then(() => true)
            .catch(() => false);
         const notesExists = await fs
            .stat(path.join(forkPath, 'notes.txt'))
            .then(() => true)
            .catch(() => false);
         const configEnvExists = await fs
            .stat(path.join(forkPath, 'config', 'app.env'))
            .then(() => true)
            .catch(() => false);
         const secretsTokenExists = await fs
            .stat(path.join(forkPath, 'secrets', 'token.txt'))
            .then(() => true)
            .catch(() => false);
         const secretsInnerExists = await fs
            .stat(path.join(forkPath, 'secrets', 'nested', 'inner.txt'))
            .then(() => true)
            .catch(() => false);

         expect(envExists).toBe(true);
         expect(envLocalExists).toBe(true);
         expect(notesExists).toBe(true);
         expect(configEnvExists).toBe(true);
         expect(secretsTokenExists).toBe(true);
         expect(secretsInnerExists).toBe(true);

         await Promise.all([
            fs.rm(path.join(forkPath, '.env.local'), { force: true }),
            fs.rm(path.join(forkPath, 'notes.txt'), { force: true }),
            fs.rm(path.join(forkPath, 'config'), { recursive: true, force: true }),
            fs.rm(path.join(forkPath, 'secrets'), { recursive: true, force: true }),
         ]);

         const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', 'feature-env']);
         expect(await parallel(removeCtx)).toBe(0);
      } finally {
         await Promise.all([
            fs.rm(path.join(tmpDir, '.env.local'), { force: true }),
            fs.rm(path.join(tmpDir, 'notes.txt'), { force: true }),
            fs.rm(path.join(tmpDir, 'config'), { recursive: true, force: true }),
            fs.rm(path.join(tmpDir, 'secrets'), { recursive: true, force: true }),
            fs.rm(path.join(tmpDir, '.env'), { force: true }),
            fs.rm(path.join(tmpDir, '.gitignore'), { force: true }),
         ]);

         await resetRepo('worktree');
         fs.writeFileSync(configPath, originalConfig, 'utf-8');
         resetConfig();
         resetCache();
      }
   });

   it('should fork from a specific ref', async () => {
      await $`${git$} commit --allow-empty --no-verify -m ${'Ref base'}`;
      const refCommit = (await $`${git$} rev-parse HEAD`).stdout.trim();

      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', 'feature-ref', refCommit]);
      const [forkResult, branchName] = await Promise.all([
         parallel(forkCtx),
         $`${git$} rev-parse --abbrev-ref HEAD`.then((child) => child.stdout.trim()),
      ]);
      expect(forkResult).toBe(0);

      const projectName = path.basename(tmpDir);
      const worktreeRoot = path.join(
         tmpRootDir,
         'tmp',
         'worktrees',
         normalizePath(projectName),
         normalizePath(branchName)
      );
      const forkPath = path.join(worktreeRoot, 'feature-ref');
      const forkHead = (await $`${git$} -C ${forkPath} rev-parse HEAD`).stdout.trim();

      expect(forkHead).toBe(refCommit);

      await resetRepo('worktree');
      const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', 'feature-ref']);
      await parallel(removeCtx);
   });

   it('should fork and join a branch-tracked worktree', async () => {
      await $`${git$} commit --allow-empty --no-verify -m ${'Branch base'}`;

      const alias = 'feature-branch';
      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias, '-b', alias]);
      const [forkResult, branchName] = await Promise.all([
         parallel(forkCtx),
         $`${git$} rev-parse --abbrev-ref HEAD`.then((child) => child.stdout.trim()),
      ]);
      expect(forkResult).toBe(0);

      const projectName = path.basename(tmpDir);
      const worktreeRoot = path.join(
         tmpRootDir,
         'tmp',
         'worktrees',
         normalizePath(projectName),
         normalizePath(branchName)
      );
      const forkPath = path.join(worktreeRoot, alias);
      const forkBranch = (
         await $`${git$} -C ${forkPath} rev-parse --abbrev-ref HEAD`
      ).stdout.trim();

      expect(forkBranch).toBe(alias);

      fs.writeFileSync(path.join(forkPath, 'branch-file.txt'), 'branch');
      await $`${git$} -C ${forkPath} add branch-file.txt`;
      await $`${git$} -C ${forkPath} commit --no-verify -m ${'Branch change'}`;
      const forkHeadBeforeJoin = (await $`${git$} -C ${forkPath} rev-parse HEAD`).stdout.trim();

      await fs.rm(path.join(forkPath, '.env.local'), { force: true });
      await fs.rm(path.join(forkPath, 'notes.txt'), { force: true });

      const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', alias]);
      const joinResult = await parallel(joinCtx);

      expect(joinResult).toBe(0);

      const originHeadAfterJoin = (await $`${git$} -C ${tmpDir} rev-parse HEAD`).stdout.trim();
      expect(originHeadAfterJoin).toBe(forkHeadBeforeJoin);

      const joinedFile = await fs
         .stat(path.join(tmpDir, 'branch-file.txt'))
         .then(() => true)
         .catch(() => false);
      expect(joinedFile).toBe(true);

      const forkStillExists = await fs
         .stat(forkPath)
         .then(() => true)
         .catch(() => false);
      expect(forkStillExists).toBe(false);
   });

   it('should rebase a kept fork onto the captured origin head before joining', async () => {
      resetCache();
      const alias = 'feature-rebase-keep';
      await $`${git$} commit --allow-empty --no-verify -m ${'Rebase join base'}`;

      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias, '--no-init']);
      expect(await parallel(forkCtx)).toBe(0);

      const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
      const forkPath = getParallelForkPath(tmpRootDir, tmpDir, alias, branchName);
      fs.writeFileSync(path.join(forkPath, 'fork-rebase.txt'), 'fork\n');
      await $`${git$} -C ${forkPath} add fork-rebase.txt`;
      await $`${git$} -C ${forkPath} commit --no-verify -m ${'Fork rebase change'}`;
      const originalForkHead = (await $`${git$} -C ${forkPath} rev-parse HEAD`).stdout.trim();

      fs.writeFileSync(path.join(tmpDir, 'origin-rebase.txt'), 'origin\n');
      await $`${git$} add origin-rebase.txt`;
      await $`${git$} commit --no-verify -m ${'Origin rebase change'}`;
      const capturedOriginHead = (await $`${git$} rev-parse HEAD`).stdout.trim();

      const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', alias, '--keep']);
      expect(await parallel(joinCtx)).toBe(0);

      const finalForkHead = (await $`${git$} -C ${forkPath} rev-parse HEAD`).stdout.trim();
      const finalOriginHead = (await $`${git$} rev-parse HEAD`).stdout.trim();
      expect(finalForkHead).toBe(finalOriginHead);
      expect(finalForkHead).not.toBe(originalForkHead);
      expect(finalForkHead).not.toBe(capturedOriginHead);
      await $`${git$} -C ${forkPath} merge-base --is-ancestor ${capturedOriginHead} HEAD`;
      expect(fs.readFileSync(path.join(tmpDir, 'fork-rebase.txt'), 'utf-8')).toBe('fork\n');
      expect(fs.readFileSync(path.join(tmpDir, 'origin-rebase.txt'), 'utf-8')).toBe('origin\n');

      const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', alias]);
      expect(await parallel(removeCtx)).toBe(0);
   }, { timeout: 20000 });

   it('should include uncommitted fork changes with --all and remove the fork', async () => {
      resetCache();
      const alias = 'feature-join-all';
      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias, '--no-init']);
      expect(await parallel(forkCtx)).toBe(0);

      const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
      const forkPath = getParallelForkPath(tmpRootDir, tmpDir, alias, branchName);
      try {
         fs.writeFileSync(path.join(forkPath, 'all-committed.txt'), 'committed\n');
         await $`${git$} -C ${forkPath} add all-committed.txt`;
         await $`${git$} -C ${forkPath} commit --no-verify -m ${'Committed all change'}`;
         fs.writeFileSync(path.join(forkPath, 'all-committed.txt'), 'committed\nunstaged\n');
         fs.writeFileSync(path.join(forkPath, 'all-uncommitted.txt'), 'uncommitted\n');
         await $`${git$} -C ${forkPath} add all-uncommitted.txt`;
         fs.writeFileSync(path.join(forkPath, 'all-untracked.txt'), 'untracked\n');
         const originalForkHead = (await $`${git$} -C ${forkPath} rev-parse HEAD`).stdout.trim();
         fs.writeFileSync(path.join(tmpDir, 'all-origin.txt'), 'origin\n');
         await $`${git$} add all-origin.txt`;
         await $`${git$} commit --no-verify -m ${'Origin all change'}`;

         const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', alias, '--all']);
         expect(await parallel(joinCtx)).toBe(0);

         expect(fs.readFileSync(path.join(tmpDir, 'all-committed.txt'), 'utf-8')).toBe(
            'committed\nunstaged\n'
         );
         expect(fs.readFileSync(path.join(tmpDir, 'all-uncommitted.txt'), 'utf-8')).toBe('uncommitted\n');
         expect(fs.readFileSync(path.join(tmpDir, 'all-untracked.txt'), 'utf-8')).toBe('untracked\n');
         expect(fs.readFileSync(path.join(tmpDir, 'all-origin.txt'), 'utf-8')).toBe('origin\n');
         expect((await $`${git$} rev-parse HEAD`).stdout.trim()).not.toBe(originalForkHead);
         expect((await $`${git$} status --porcelain=v1 -- all-uncommitted.txt`).stdout.trim()).toMatch(
            /^A\s+all-uncommitted\.txt$/
         );
         expect((await $`${git$} status --porcelain=v1 -- all-committed.txt`).stdout.trim()).toMatch(
            /^M\s+all-committed\.txt$/
         );
         expect((await $`${git$} status --porcelain=v1 -- all-untracked.txt`).stdout.trim()).toBe(
            '?? all-untracked.txt'
         );
         expect(fs.existsSync(forkPath)).toBe(false);
      } finally {
         if (fs.existsSync(forkPath)) await forceRemoveWorktreePath(forkPath);
         await $`${git$} -C ${tmpDir} reset --hard HEAD`;
      }
   }, { timeout: 20000 });

   it('should rebase a tracked local branch and keep its head equal to origin', async () => {
      resetCache();
      const alias = 'feature-branch-rebase';
      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias, '-b', alias, '--no-init']);
      expect(await parallel(forkCtx)).toBe(0);

      const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
      const forkPath = getParallelForkPath(tmpRootDir, tmpDir, alias, branchName);
      fs.writeFileSync(path.join(forkPath, 'tracked-rebase.txt'), 'fork\n');
      await $`${git$} -C ${forkPath} add tracked-rebase.txt`;
      await $`${git$} -C ${forkPath} commit --no-verify -m ${'Tracked fork change'}`;

      fs.writeFileSync(path.join(tmpDir, 'tracked-origin.txt'), 'origin\n');
      await $`${git$} add tracked-origin.txt`;
      await $`${git$} commit --no-verify -m ${'Tracked origin change'}`;

      const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', alias, '--keep']);
      expect(await parallel(joinCtx)).toBe(0);

      const forkHead = (await $`${git$} -C ${forkPath} rev-parse HEAD`).stdout.trim();
      const forkBranch = (await $`${git$} -C ${forkPath} rev-parse --abbrev-ref HEAD`).stdout.trim();
      const originHead = (await $`${git$} rev-parse HEAD`).stdout.trim();
      const branchRef = (await $`${git$} rev-parse refs/heads/${alias}`).stdout.trim();
      expect(forkBranch).toBe(alias);
      expect(branchRef).toBe(forkHead);
      expect(forkHead).toBe(originHead);

      const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', alias]);
      expect(await parallel(removeCtx)).toBe(0);
   }, { timeout: 20000 });

   it('should join an unrelated fork after origin advances its submodule and remove it', async () => {
      resetCache();
      const alias = 'feature-submodule-origin-advance';
      let forkPath = '';
      try {
         const setup = await createAdvancedOriginSubmoduleFork(alias);
         ({ forkPath } = setup);

         const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', alias]);
         expect(await parallel(joinCtx)).toBe(0);

         expect(fs.existsSync(forkPath)).toBe(false);
         const originSubmoduleHead = (
            await $`${git$} -C ${setup.originSubmodulePath} rev-parse HEAD`
         ).stdout.trim();
         const originGitlink = (
            await $`${git$} ls-tree HEAD -- ${setup.submodulePath}`
         ).stdout.trim();
         expect(originSubmoduleHead).toBe(setup.advancedHead);
         expect(originGitlink).toContain(`${originSubmoduleHead}\t${setup.submodulePath}`);
      } finally {
         if (forkPath && fs.existsSync(forkPath)) {
            await forceRemoveWorktreePath(forkPath);
         }
         await resetRepo('worktree');
      }
   }, { timeout: 30000 });

   it('should keep a clean fork aligned when origin advances its submodule', async () => {
      resetCache();
      const alias = 'feature-submodule-origin-advance-keep';
      let forkPath = '';
      try {
         const setup = await createAdvancedOriginSubmoduleFork(alias);
         ({ forkPath } = setup);
         await $`${git$} -C ${setup.originSubmodulePath} checkout -b ${'preserve-origin-submodule-branch'}`;

         const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', alias, '--keep']);
         expect(await parallel(joinCtx)).toBe(0);

         expect(fs.existsSync(forkPath)).toBe(true);
         const forkHead = (await $`${git$} -C ${forkPath} rev-parse HEAD`).stdout.trim();
         const originHead = (await $`${git$} rev-parse HEAD`).stdout.trim();
         const forkStatus = (
            await $`${git$} -C ${forkPath} status --porcelain=v1 --untracked-files=normal`
         ).stdout.trim();
         const originSubmoduleHead = (
            await $`${git$} -C ${setup.originSubmodulePath} rev-parse HEAD`
         ).stdout.trim();
         const originSubmoduleBranch = (
            await $`${git$} -C ${setup.originSubmodulePath} rev-parse --abbrev-ref HEAD`
         ).stdout.trim();
         const forkSubmoduleHead = (
            await $`${git$} -C ${setup.forkSubmodulePath} rev-parse HEAD`
         ).stdout.trim();
         const originGitlink = (
            await $`${git$} ls-tree HEAD -- ${setup.submodulePath}`
         ).stdout.trim();

         expect(forkHead).toBe(originHead);
         expect(forkStatus).toBe('');
         expect(originSubmoduleHead).toBe(setup.advancedHead);
         expect(originSubmoduleBranch).toBe('preserve-origin-submodule-branch');
         expect(forkSubmoduleHead).toBe(originSubmoduleHead);
         expect(originGitlink).toContain(`${originSubmoduleHead}\t${setup.submodulePath}`);
      } finally {
         if (forkPath && fs.existsSync(forkPath)) {
            await forceRemoveWorktreePath(forkPath);
         }
         await resetRepo('worktree');
      }
   }, { timeout: 30000 });

   it('should list active worktrees', async () => {
      const listCtx = createGdxContext(tmpDir, ['parallel', 'list']);
      const result = await parallel(listCtx);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain('feature-1');
   });

   it('should mark current worktree and show fork headers', async () => {
      const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
      const projectName = path.basename(tmpDir);
      const worktreeRoot = path.join(
         tmpRootDir,
         'tmp',
         'worktrees',
         normalizePath(projectName),
         normalizePath(branchName)
      );
      const forkPath = path.join(worktreeRoot, 'feature-1');

      resetCache();
      const listCtx = createGdxContext(forkPath, ['parallel', 'list']);
      const result = await parallel(listCtx);

      const output = asUnixPath(buffer.stdout);

      expect(result).toBe(0);
      expect(output).toContain(`Project: ${projectName}`);
      expect(output).toContain(`Branch: ${branchName}`);
      expect(output).toContain(`Origin: ${asUnixPath(tmpDir)}`);
      expect(output).toContain('Current: feature-1');
      expect(output).toContain('(use "origin" alias to refer to main worktree)');

      const markerMatch = output.match(/^([●○])\s+feature-1\b/m);
      expect(markerMatch?.[1]).toBe('●');
   });

   it('should show branch info for branch-tracked worktrees', async () => {
      const alias = 'feature-branch-list';
      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias, '-b', alias]);
      expect(await parallel(forkCtx)).toBe(0);

      resetCache();
      const listCtx = createGdxContext(tmpDir, ['parallel', 'list']);
      const result = await parallel(listCtx);

      expect(result).toBe(0);
      expect(stripAnsiColor(buffer.stdout)).toContain(`(branch:${alias})`);

      const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', alias]);
      await parallel(removeCtx);
   });

   it('should show commit hint in short list output', async () => {
      const alias = 'feature-short-hint';
      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias]);
      expect(await parallel(forkCtx)).toBe(0);
      buffer.stdout = '';

      const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
      const projectName = path.basename(tmpDir);
      const worktreeRoot = path.join(
         tmpRootDir,
         'tmp',
         'worktrees',
         normalizePath(projectName),
         normalizePath(branchName)
      );
      const forkPath = path.join(worktreeRoot, alias);
      const gitExec = Array.isArray(git$) ? git$[0] : git$;
      const forkGit$ = [gitExec, '-C', forkPath];

      for (let i = 1; i <= 4; i++) {
         await $`${forkGit$} commit --allow-empty --no-verify -m ${`Add short hint ${i}`}`;
      }

      await fs.rm(path.join(forkPath, '.env.local'), { force: true });
      await fs.rm(path.join(forkPath, 'notes.txt'), { force: true });

      resetCache();
      const listCtx = createGdxContext(tmpDir, ['parallel', 'list', '-s']);
      const listResult = await parallel(listCtx);

      expect(listResult).toBe(0);
      expect(buffer.stdout).toContain('+1 more');

      const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', alias]);
      expect(await parallel(removeCtx)).toBe(0);
   });

   it('should open and switch to correct paths for alias and origin', async () => {
      resetCache();
      const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
      const projectName = path.basename(tmpDir);
      const worktreeRoot = path.join(
         tmpRootDir,
         'tmp',
         'worktrees',
         normalizePath(projectName),
         normalizePath(branchName)
      );
      const forkPath = path.join(worktreeRoot, 'feature-1');

      resetCache();
      const openAliasCtx = createGdxContext(tmpDir, ['parallel', 'open', 'feature-1']);
      expect(await parallel(openAliasCtx)).toBe(0);
      resetCache();
      const openOriginCtx = createGdxContext(forkPath, ['parallel', 'open', 'origin']);
      expect(await parallel(openOriginCtx)).toBe(0);

      expect(tracker.openedPaths.map((value) => asUnixPath(value))).toEqual([
         asUnixPath(forkPath),
         asUnixPath(tmpDir),
      ]);

      if (!GDX_RESULT_FILE) {
         const switchAliasCtx = createGdxContext(tmpDir, ['parallel', 'switch', 'feature-1']);
         expect(await parallel(switchAliasCtx)).toBe(1);
         expect(buffer.stderr).toContain('requires the shell integration');
         return;
      }

      resetCache();
      const switchAliasCtx = createGdxContext(tmpDir, ['parallel', 'switch', 'feature-1']);
      expect(await parallel(switchAliasCtx)).toBe(0);
      resetCache();
      const switchOriginCtx = createGdxContext(forkPath, ['parallel', 'switch', 'origin']);
      expect(await parallel(switchOriginCtx)).toBe(0);

      expect(tracker.scheduledDirs.map((value) => asUnixPath(value))).toEqual([
         asUnixPath(forkPath),
         asUnixPath(tmpDir),
      ]);
   });

   it('should fail to fork with invalid alias', async () => {
      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', 'invalid/name']);
      const result = await parallel(forkCtx);

      expect(result).toBe(1);
      // LINK: dwmal2m string literal in spec
      expect(buffer.stderr).toContain('contains invalid characters');
   });

   it('should rename a fork and reject an existing target name', async () => {
      const sourceAlias = 'rename-source';
      const renamedAlias = 'rename-destination';
      const existingAlias = 'rename-existing';
      expect(await parallel(createGdxContext(tmpDir, ['parallel', 'fork', sourceAlias]))).toBe(0);
      expect(await parallel(createGdxContext(tmpDir, ['parallel', 'fork', existingAlias]))).toBe(0);

      const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
      const sourcePath = getParallelForkPath(tmpRootDir, tmpDir, sourceAlias, branchName);
      const renamedPath = getParallelForkPath(tmpRootDir, tmpDir, renamedAlias, branchName);

      buffer.stdout = '';
      expect(
         await parallel(createGdxContext(tmpDir, ['parallel', 'rename', sourceAlias, renamedAlias]))
      ).toBe(0);
      expect(buffer.stdout).toContain(`Renamed fork '${sourceAlias}' to '${renamedAlias}'`);
      expect(fs.existsSync(sourcePath)).toBe(false);
      expect(fs.existsSync(renamedPath)).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(renamedPath, '.git-parallel.json'), 'utf-8')).alias).toBe(
         renamedAlias
      );

      expect(
         await parallel(createGdxContext(tmpDir, ['parallel', 'rename', renamedAlias, existingAlias]))
      ).toBe(1);
      expect(buffer.stderr).toContain(`Worktree alias '${existingAlias}' already exists`);
      expect(fs.existsSync(renamedPath)).toBe(true);

      expect(await parallel(createGdxContext(tmpDir, ['parallel', 'remove', renamedAlias]))).toBe(0);
      expect(await parallel(createGdxContext(tmpDir, ['parallel', 'remove', existingAlias]))).toBe(0);
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

   it('should show commits and hint in short list output', async () => {
      const alias = 'feature-short';
      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias]);
      expect(await parallel(forkCtx)).toBe(0);
      buffer.stdout = '';

      const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
      const projectName = path.basename(tmpDir);
      const worktreeRoot = path.join(
         tmpRootDir,
         'tmp',
         'worktrees',
         normalizePath(projectName),
         normalizePath(branchName)
      );
      const forkPath = path.join(worktreeRoot, alias);

      buffer.stdout = '';

      const gitExe = Array.isArray(git$) ? git$[0] : git$;
      const forkGit$ = [gitExe, '-C', forkPath];

      for (let i = 1; i <= 4; i++) {
         await $`${forkGit$} commit --allow-empty --no-verify -m ${`Add short ${i}`}`;
      }

      await fs.rm(path.join(forkPath, '.env.local'), { force: true });
      await fs.rm(path.join(forkPath, 'notes.txt'), { force: true });

      resetCache();
      const listCtx = createGdxContext(tmpDir, ['parallel', 'list']);
      const listResult = await parallel(listCtx);

      expect(listResult).toBe(0);
      const output = asUnixPath(buffer.stdout);

      expect(output).toContain('Add short 4');
      expect(output).toContain('Add short 3');
      expect(output).toContain('Add short 2');
      expect(output).toContain('Add short 1');

      const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', alias]);
      expect(await parallel(removeCtx)).toBe(0);
   });

   it('should not list commits already merged into origin', async () => {
      const alias = 'feature-merged-list';
      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias]);
      expect(await parallel(forkCtx)).toBe(0);

      const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
      const projectName = path.basename(tmpDir);
      const worktreeRoot = path.join(
         tmpRootDir,
         'tmp',
         'worktrees',
         normalizePath(projectName),
         normalizePath(branchName)
      );
      const forkPath = path.join(worktreeRoot, alias);
      const gitExec = Array.isArray(git$) ? git$[0] : git$;
      const forkGit$ = [gitExec, '-C', forkPath];

      const commitMessages = ['Merged list 1', 'Merged list 2', 'Merged list 3'];
      for (const message of commitMessages) {
         await $`${forkGit$} commit --allow-empty --no-verify -m ${message}`;
      }

      await fs.rm(path.join(forkPath, '.env.local'), { force: true });
      await fs.rm(path.join(forkPath, 'notes.txt'), { force: true });

      const forkHead = (await $`${git$} -C ${forkPath} rev-parse HEAD`).stdout.trim();
      await $`${git$} -C ${tmpDir} merge --no-edit ${forkHead}`;

      resetCache();
      const listCtx = createGdxContext(tmpDir, ['parallel', 'list']);
      const listResult = await parallel(listCtx);

      expect(listResult).toBe(0);
      const output = stripAnsiColor(buffer.stdout.replace(/\r/g, ''));
      expect(output).toContain(alias);
      expect(output).toContain('up-to-date');
      for (const message of commitMessages) {
         expect(output).not.toContain(message);
      }

      const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', alias]);
      expect(await parallel(removeCtx)).toBe(0);
   });

   it(
      'should block removal when submodules are dirty',
      async () => {
         resetCache();
         const submoduleRoot = path.join(tmpRootDir, 'submodule');
         fs.mkdirSync(submoduleRoot, { recursive: true });
         await $`${git$} -C ${submoduleRoot} init`;
         await setTestGitConfig(submoduleRoot, 'user.name', 'Test User');
         await setTestGitConfig(submoduleRoot, 'user.email', 'test@example.com');
         await $`${git$} -C ${submoduleRoot} commit --allow-empty --no-verify -m ${'init submodule'}`;

         const submoduleSha = (await $`${git$} -C ${submoduleRoot} rev-parse HEAD`).stdout.trim();
         const submoduleUrl = asUnixPath(submoduleRoot);
         const gitmodulesContent = `[submodule "deps/submodule"]\n\tpath = deps/submodule\n\turl = ${submoduleUrl}\n`;
         await $`${git$} -C ${tmpDir} update-index --add --cacheinfo 160000 ${submoduleSha} ${'deps/submodule'}`;
         fs.writeFileSync(path.join(tmpDir, '.gitmodules'), gitmodulesContent);
         await $`${git$} -C ${tmpDir} add .gitmodules`;
         await $`${git$} -C ${tmpDir} commit --no-verify -m ${'Add submodule'}`;

         const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', 'feature-submodule']);
         expect(await parallel(forkCtx)).toBe(0);

         const worktreeRoot = path.join(tmpRootDir, 'tmp', 'worktrees', 'project', 'master');
         const forkPath = path.join(worktreeRoot, 'feature-submodule');

         try {
            const submodulePath = path.join(forkPath, 'deps', 'submodule');
            const submoduleExists = await fs
               .stat(submodulePath)
               .then(() => true)
               .catch(() => false);
            if (!submoduleExists) {
               fs.mkdirSync(path.join(forkPath, 'deps'), { recursive: true });
               await $`${git$} -C ${forkPath} -c protocol.file.allow=always clone ${submoduleRoot} ${'deps/submodule'}`;
            }
            fs.writeFileSync(path.join(submodulePath, 'dirty.txt'), 'dirty');

            // Mark submodule folder as unchanged to avoid dirty detection from working tree
            await $`${git$} -C ${forkPath} update-index --assume-unchanged ${'deps/submodule'}`;

            resetCache();
            const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', 'feature-submodule']);
            const removeResult = await parallel(removeCtx);

            expect(removeResult).toBe(1);
            expect(buffer.stderr).toContain('dirty submodules');
         } finally {
            await $`${git$} worktree prune --expire now`;
            await fs.rm(forkPath, { recursive: true, force: true });
            await resetRepo('worktree');
         }
      },
      { timeout: 15000 }
   );

   it(
      'should remove worktree with clean submodules',
      async () => {
         resetCache();
         const gitExe = Array.isArray(git$) ? git$[0] : git$;
         const submoduleRoot = path.join(tmpRootDir, 'submodule-deinit');
         fs.mkdirSync(submoduleRoot, { recursive: true });
         await $`${gitExe} -C ${submoduleRoot} init`;
         await setTestGitConfig(submoduleRoot, 'user.name', 'Test User');
         await setTestGitConfig(submoduleRoot, 'user.email', 'test@example.com');
         await $`${gitExe} -C ${submoduleRoot} commit --allow-empty --no-verify -m ${'init submodule'}`;

         const submoduleUrl = asUnixPath(submoduleRoot);
         await addSubmodule(git$, tmpDir, submoduleUrl, 'deps/submodule');
         await $`${gitExe} -C ${tmpDir} add .gitmodules ${'deps/submodule'}`;
         await $`${gitExe} -C ${tmpDir} commit --no-verify -m ${'Add submodule'}`;

         const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', 'feature-deinit']);
         expect(await parallel(forkCtx)).toBe(0);

         const worktreeRoot = path.join(tmpRootDir, 'tmp', 'worktrees', 'project', 'master');
         const forkPath = path.join(worktreeRoot, 'feature-deinit');
         const submodulePath = path.join(forkPath, 'deps', 'submodule');
         const gitMarker = path.join(submodulePath, '.git');

         try {
            const markerExists = await fs
               .stat(gitMarker)
               .then(() => true)
               .catch(() => false);
            if (!markerExists) {
               await updateSubmodules(git$, forkPath, { recursive: true });
            }

            await $`${gitExe} -C ${submodulePath} reset --hard`;
            await $`${gitExe} -C ${submodulePath} clean -fd`;
            const submoduleStatus = (
               await $`${gitExe} -C ${submodulePath} status --porcelain=v1 --untracked-files=normal`
            ).stdout.trim();
            expect(submoduleStatus.length).toBe(0);

            resetCache();
            const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', 'feature-deinit']);
            const removeResult = await parallel(removeCtx);

            expect(removeResult).toBe(0);
            expect(buffer.stdout.toLowerCase()).toContain('removed worktree');
         } finally {
            await forceRemoveWorktreePath(forkPath);
            await fs.rm(path.join(tmpDir, 'deps'), { recursive: true, force: true });
            await resetRepo('worktree');
         }
      },
      { timeout: 15000 }
   );

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

   it(
      'should remove all worktrees recursively',
      async () => {
         const forkOneCtx = createGdxContext(tmpDir, ['parallel', 'fork', 'feature-r1']);
         const forkTwoCtx = createGdxContext(tmpDir, ['parallel', 'fork', 'feature-r2']);
         expect(await parallel(forkOneCtx)).toBe(0);
         expect(await parallel(forkTwoCtx)).toBe(0);

         const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
         const projectName = path.basename(tmpDir);
         const worktreeRoot = path.join(
            tmpRootDir,
            'tmp',
            'worktrees',
            normalizePath(projectName),
            normalizePath(branchName)
         );
         const forkOnePath = path.join(worktreeRoot, 'feature-r1');
         const forkTwoPath = path.join(worktreeRoot, 'feature-r2');

         const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', '-r']);
         const removeResult = await parallel(removeCtx);

         expect(removeResult).toBe(0);

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
      },
      { timeout: 20000 }
   );

   it(
      'should join all worktrees recursively',
      async () => {
         const forkOneCtx = createGdxContext(tmpDir, ['parallel', 'fork', 'feature-1']);
         const forkTwoCtx = createGdxContext(tmpDir, ['parallel', 'fork', 'feature-2']);
         expect(await parallel(forkOneCtx)).toBe(0);
         expect(await parallel(forkTwoCtx)).toBe(0);

         const worktreeRoot = path.join(tmpRootDir, 'tmp', 'worktrees', 'project', 'master');
         const forkOnePath = path.join(worktreeRoot, 'feature-1');
         const forkTwoPath = path.join(worktreeRoot, 'feature-2');

         fs.writeFileSync(path.join(forkOnePath, 'feature-one.txt'), 'one');
         await $`${git$} -C ${forkOnePath} add feature-one.txt`;
         await $`${git$} -C ${forkOnePath} commit -m ${'Add feature one'}`;

         fs.writeFileSync(path.join(forkTwoPath, 'feature-two.txt'), 'two');
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
      },
      { timeout: 20000 }
   );

   it('should synchronize every kept fork after a recursive join', async () => {
      resetCache();
      const aliases = ['feature-keep-one', 'feature-keep-two'];
      for (const alias of aliases) {
         const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias, '--no-init']);
         expect(await parallel(forkCtx)).toBe(0);
      }

      const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
      const forkPaths = aliases.map((alias) =>
         getParallelForkPath(tmpRootDir, tmpDir, alias, branchName)
      );
      for (let index = 0; index < forkPaths.length; index++) {
         const fileName = `recursive-keep-${index}.txt`;
         fs.writeFileSync(path.join(forkPaths[index], fileName), `${index}\n`);
         await $`${git$} -C ${forkPaths[index]} add ${fileName}`;
         await $`${git$} -C ${forkPaths[index]} commit --no-verify -m ${`Recursive keep ${index}`}`;
      }

      const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', '-r', '--keep']);
      expect(await parallel(joinCtx)).toBe(0);

      const originHead = (await $`${git$} rev-parse HEAD`).stdout.trim();
      for (const forkPath of forkPaths) {
         expect((await $`${git$} -C ${forkPath} rev-parse HEAD`).stdout.trim()).toBe(originHead);
      }

      const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', '-r']);
      expect(await parallel(removeCtx)).toBe(0);
   }, { timeout: 30000 });

   it('should transfer later submodule commits to earlier forks during recursive keep', async () => {
      resetCache();
      const gitExec = Array.isArray(git$) ? git$[0] : git$;
      const submoduleRoot = path.join(tmpRootDir, 'recursive-keep-submodule-source');
      const nestedRoot = path.join(tmpRootDir, 'recursive-keep-nested-source');
      const submodulePath = 'deps/recursive-keep-submodule';
      const nestedPath = 'nested/child';
      const aliases = ['recursive-keep-a', 'recursive-keep-b', 'recursive-keep-z-no-init'];
      let forkPaths: string[] = [];
      try {
         fs.mkdirSync(submoduleRoot, { recursive: true });
         await $`${gitExec} -C ${submoduleRoot} init`;
         await setTestGitConfig(submoduleRoot, 'user.name', 'Test User');
         await setTestGitConfig(submoduleRoot, 'user.email', 'test@example.com');
         fs.writeFileSync(path.join(submoduleRoot, 'base.txt'), 'base\n');
         await $`${gitExec} -C ${submoduleRoot} add base.txt`;
         await $`${gitExec} -C ${submoduleRoot} commit --no-verify -m ${'Recursive submodule base'}`;

         fs.mkdirSync(nestedRoot, { recursive: true });
         await $`${gitExec} -C ${nestedRoot} init`;
         await setTestGitConfig(nestedRoot, 'user.name', 'Test User');
         await setTestGitConfig(nestedRoot, 'user.email', 'test@example.com');
         fs.writeFileSync(path.join(nestedRoot, 'nested-base.txt'), 'base\n');
         await $`${gitExec} -C ${nestedRoot} add nested-base.txt`;
         await $`${gitExec} -C ${nestedRoot} commit --no-verify -m ${'Nested submodule base'}`;
         await addSubmodule(gitExec, submoduleRoot, asUnixPath(nestedRoot), nestedPath);
         await $`${gitExec} -C ${submoduleRoot} add .gitmodules ${nestedPath}`;
         await $`${gitExec} -C ${submoduleRoot} commit --no-verify -m ${'Add nested submodule'}`;

         await addSubmodule(git$, tmpDir, asUnixPath(submoduleRoot), submodulePath);
         await $`${gitExec} -C ${tmpDir} add .gitmodules ${submodulePath}`;
         await $`${gitExec} -C ${tmpDir} commit --no-verify -m ${'Add recursive keep submodule'}`;

         for (const [index, alias] of aliases.entries()) {
            const forkCtx = createGdxContext(tmpDir, [
               'parallel',
               'fork',
               alias,
               ...(index === aliases.length - 1 ? ['--no-init'] : []),
            ]);
            expect(await parallel(forkCtx)).toBe(0);
         }
         const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
         forkPaths = aliases.map((alias) =>
            getParallelForkPath(tmpRootDir, tmpDir, alias, branchName)
         );

         fs.writeFileSync(path.join(forkPaths[0], 'earlier-fork.txt'), 'earlier\n');
         await $`${git$} -C ${forkPaths[0]} add earlier-fork.txt`;
         await $`${git$} -C ${forkPaths[0]} commit --no-verify -m ${'Earlier kept fork'}`;

         const laterSubmodulePath = path.join(forkPaths[1], submodulePath);
         await setTestGitConfig(laterSubmodulePath, 'user.name', 'Test User');
         await setTestGitConfig(laterSubmodulePath, 'user.email', 'test@example.com');
         const laterNestedPath = path.join(laterSubmodulePath, nestedPath);
         await setTestGitConfig(laterNestedPath, 'user.name', 'Test User');
         await setTestGitConfig(laterNestedPath, 'user.email', 'test@example.com');
         fs.writeFileSync(path.join(laterNestedPath, 'later.txt'), 'later\n');
         await $`${gitExec} -C ${laterNestedPath} add later.txt`;
         await $`${gitExec} -C ${laterNestedPath} commit --no-verify -m ${'Later nested commit'}`;
         const laterNestedHead = (
            await $`${gitExec} -C ${laterNestedPath} rev-parse HEAD`
         ).stdout.trim();
         await $`${gitExec} -C ${laterSubmodulePath} add ${nestedPath}`;
         await $`${gitExec} -C ${laterSubmodulePath} commit --no-verify -m ${'Advance nested submodule'}`;
         const laterSubmoduleHead = (
            await $`${gitExec} -C ${laterSubmodulePath} rev-parse HEAD`
         ).stdout.trim();
         await $`${git$} -C ${forkPaths[1]} add ${submodulePath}`;
         await $`${git$} -C ${forkPaths[1]} commit --no-verify -m ${'Advance recursive submodule'}`;

         const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', '-r', '--keep']);
         expect(await parallel(joinCtx)).toBe(0);
         const originHead = (await $`${git$} rev-parse HEAD`).stdout.trim();
         for (const forkPath of forkPaths) {
            expect((await $`${git$} -C ${forkPath} rev-parse HEAD`).stdout.trim()).toBe(originHead);
         }
         for (const forkPath of forkPaths.slice(0, 2)) {
            expect(
               (await $`${gitExec} -C ${path.join(forkPath, submodulePath)} rev-parse HEAD`).stdout.trim()
            ).toBe(laterSubmoduleHead);
            expect(
               (
                  await $`${gitExec} -C ${path.join(forkPath, submodulePath, nestedPath)} rev-parse HEAD`
               ).stdout.trim()
            ).toBe(laterNestedHead);
         }
         expect(fs.existsSync(path.join(forkPaths[2], submodulePath, '.git'))).toBe(false);
      } finally {
         for (const forkPath of forkPaths) {
            if (fs.existsSync(forkPath)) await forceRemoveWorktreePath(forkPath);
         }
         await fs.rm(submoduleRoot, { recursive: true, force: true });
         await fs.rm(nestedRoot, { recursive: true, force: true });
         await resetRepo('full');
      }
   }, { timeout: 45000 });

   it('should reject recursive join with alias', async () => {
      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', 'feature-1']);
      expect(await parallel(forkCtx)).toBe(0);

      const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', '-r', 'feature-1']);
      const joinResult = await parallel(joinCtx);

      expect(joinResult).toBe(1);
      expect(buffer.stderr).toContain('Recursive join does not accept an alias');
   });

   it('should reject recursive remove with alias', async () => {
      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', 'feature-r3']);
      expect(await parallel(forkCtx)).toBe(0);

      const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', '-r', 'feature-r3']);
      const removeResult = await parallel(removeCtx);

      expect(removeResult).toBe(1);
      expect(buffer.stderr).toContain('Recursive remove does not accept an alias');

      const cleanupCtx = createGdxContext(tmpDir, ['parallel', 'remove', 'feature-r3']);
      await parallel(cleanupCtx);
   });

   it('should reject recursive join with --all', async () => {
      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', 'feature-3']);
      expect(await parallel(forkCtx)).toBe(0);

      const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', '-r', '--all']);
      const joinResult = await parallel(joinCtx);

      expect(joinResult).toBe(1);
      expect(buffer.stderr).toContain('Recursive join does not support --all');
   });

   it('should sync detached fork to origin head and reset metadata', async () => {
      resetCache();
      const alias = 'feature-sync-detached';
      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias, '--no-init']);
      expect(await parallel(forkCtx)).toBe(0);

      const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
      const forkPath = getParallelForkPath(tmpRootDir, tmpDir, alias, branchName);
      const forkGit$ = [Array.isArray(git$) ? git$[0] : git$, '-C', forkPath];

      await $`${forkGit$} commit --allow-empty --no-verify -m ${'Fork sync commit'}`;
      await $`${git$} commit --allow-empty --no-verify -m ${'Origin sync commit'}`;
      const originHead = (await $`${git$} rev-parse HEAD`).stdout.trim();

      const metaPath = path.join(forkPath, '.git-parallel.json');
      const metaBefore = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as {
         baseCommit: string;
         joinCursor?: string;
      };
      metaBefore.joinCursor = (await $`${forkGit$} rev-parse HEAD`).stdout.trim();
      fs.writeFileSync(metaPath, JSON.stringify(metaBefore, null, 2), 'utf-8');

      const syncCtx = createGdxContext(tmpDir, ['parallel', 'sync', alias]);
      expect(await parallel(syncCtx)).toBe(0);

      const forkHead = (await $`${forkGit$} rev-parse HEAD`).stdout.trim();
      expect(forkHead).toBe(originHead);
      const syncLog = stripAnsiColor(buffer.stdout);
      expect(syncLog).toContain(`Fork '${alias}' synchronized with origin.`);

      const metaAfter = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as {
         baseCommit: string;
         joinCursor?: string;
         submoduleCursors?: Record<string, string>;
      };
      expect(metaAfter.baseCommit).toBe(originHead);
      expect(metaAfter.joinCursor).toBeUndefined();
      expect(metaAfter.submoduleCursors).toBeUndefined();

      const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', alias]);
      expect(await parallel(removeCtx)).toBe(0);
   });

   it('should sync detached fork even when origin worktree is dirty', async () => {
      resetCache();
      const alias = 'feature-sync-origin-dirty';
      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias, '--no-init']);
      expect(await parallel(forkCtx)).toBe(0);

      const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
      const forkPath = getParallelForkPath(tmpRootDir, tmpDir, alias, branchName);
      const forkGit$ = [Array.isArray(git$) ? git$[0] : git$, '-C', forkPath];

      await $`${forkGit$} commit --allow-empty --no-verify -m ${'Fork sync dirty commit'}`;
      await $`${git$} commit --allow-empty --no-verify -m ${'Origin sync dirty commit'}`;
      const originHead = (await $`${git$} rev-parse HEAD`).stdout.trim();

      const dirtyFile = path.join(tmpDir, 'origin-untracked-sync.txt');
      fs.writeFileSync(dirtyFile, 'origin is dirty');

      const syncCtx = createGdxContext(tmpDir, ['parallel', 'sync', alias]);
      expect(await parallel(syncCtx)).toBe(0);

      const forkHead = (await $`${forkGit$} rev-parse HEAD`).stdout.trim();
      expect(forkHead).toBe(originHead);

      const originStatus = (await $`${git$} status --porcelain=v1 --untracked-files=normal`).stdout;
      expect(originStatus).toContain('?? origin-untracked-sync.txt');

      await fs.rm(dirtyFile, { force: true });

      const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', alias]);
      expect(await parallel(removeCtx)).toBe(0);
   });

   it('should sync branch fork by merging origin and honoring hard clear', async () => {
      resetCache();
      const alias = 'feature-sync-branch';
      const forkCtx = createGdxContext(tmpDir, [
         'parallel',
         'fork',
         alias,
         '-b',
         alias,
         '--no-init',
      ]);
      expect(await parallel(forkCtx)).toBe(0);

      const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
      const forkPath = getParallelForkPath(tmpRootDir, tmpDir, alias, branchName);
      const forkGit$ = [Array.isArray(git$) ? git$[0] : git$, '-C', forkPath];

      await $`${forkGit$} commit --allow-empty --no-verify -m ${'Fork branch sync commit'}`;

      fs.writeFileSync(path.join(tmpDir, 'shared-sync.txt'), 'origin change\n');
      await $`${git$} add shared-sync.txt`;
      await $`${git$} commit --no-verify -m ${'Origin branch sync commit'}`;

      fs.writeFileSync(path.join(forkPath, 'scratch.txt'), 'local dirty');
      const syncFailCtx = createGdxContext(tmpDir, ['parallel', 'sync', alias]);
      expect(await parallel(syncFailCtx)).toBe(1);
      expect(buffer.stderr).toContain('has uncommitted changes');

      buffer.stdout = '';
      buffer.stderr = '';
      const syncCtx = createGdxContext(tmpDir, ['parallel', 'sync', alias, '--hard']);
      expect(await parallel(syncCtx)).toBe(0);

      const mergedSubjects = (await $`${forkGit$} log --format=%s -3`).stdout;
      expect(mergedSubjects).toContain("Merge commit '");
      expect(mergedSubjects).toContain('Fork branch sync commit');
      const mergeParents = (await $`${forkGit$} log -1 --format=%P`).stdout.trim().split(/\s+/);
      expect(mergeParents.length).toBe(2);
      const sharedContent = fs.readFileSync(path.join(forkPath, 'shared-sync.txt'), 'utf-8');
      expect(sharedContent).toBe('origin change\n');
      expect(fs.existsSync(path.join(forkPath, 'scratch.txt'))).toBe(false);

      const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', alias]);
      expect(await parallel(removeCtx)).toBe(0);
   }, { timeout: 15000 });

   it('should pick commits from origin into current fork', async () => {
      resetCache();
      const alias = 'feature-pick-origin';
      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias, '--no-init']);
      expect(await parallel(forkCtx)).toBe(0);

      const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
      const forkPath = getParallelForkPath(tmpRootDir, tmpDir, alias, branchName);

      fs.writeFileSync(path.join(tmpDir, 'pick-origin.txt'), 'from origin');
      await $`${git$} add pick-origin.txt`;
      await $`${git$} commit --no-verify -m ${'Origin pick commit'}`;
      const originCommit = (await $`${git$} rev-parse HEAD`).stdout.trim();

      const pickCtx = createGdxContext(forkPath, ['parallel', 'pick', 'origin', originCommit]);
      expect(await parallel(pickCtx)).toBe(0);

      expect(fs.readFileSync(path.join(forkPath, 'pick-origin.txt'), 'utf-8')).toBe('from origin');
      const forkLog = (await $`${git$} -C ${forkPath} log -1 --format=%s`).stdout.trim();
      expect(forkLog).toBe('Origin pick commit');

      const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', alias]);
      expect(await parallel(removeCtx)).toBe(0);
   });

   it(
      'should pick submodule commits from matching fork submodule',
      async () => {
         resetCache();
         const gitExe = Array.isArray(git$) ? git$[0] : git$;
         const submoduleRoot = path.join(tmpRootDir, 'submodule-pick');
         fs.mkdirSync(submoduleRoot, { recursive: true });
         await $`${gitExe} -C ${submoduleRoot} init`;
         await setTestGitConfig(submoduleRoot, 'user.name', 'Test User');
         await setTestGitConfig(submoduleRoot, 'user.email', 'test@example.com');
         await $`${gitExe} -C ${submoduleRoot} commit --allow-empty --no-verify -m ${'init submodule'}`;

         const submoduleUrl = asUnixPath(submoduleRoot);
         const submodulePath = 'deps/submodule-pick';
         await addSubmodule(git$, tmpDir, submoduleUrl, submodulePath);
         await $`${gitExe} -C ${tmpDir} add .gitmodules ${submodulePath}`;
         await $`${gitExe} -C ${tmpDir} commit --no-verify -m ${'Add submodule'}`;

         const alias = 'feature-pick-sub';
         const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias, '--no-init']);
         expect(await parallel(forkCtx)).toBe(0);

         const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
         const forkPath = getParallelForkPath(tmpRootDir, tmpDir, alias, branchName);
         await updateSubmodules(git$, forkPath, { recursive: true });

         const forkSubmodulePath = path.join(forkPath, submodulePath);
         const originSubmodulePath = path.join(tmpDir, submodulePath);
         fs.writeFileSync(path.join(forkSubmodulePath, 'pick-sub.txt'), 'sub pick');
         await $`${gitExe} -C ${forkSubmodulePath} add pick-sub.txt`;
         await $`${gitExe} -C ${forkSubmodulePath} -c user.name=${'Test User'} -c user.email=${'test@example.com'} -c committer.name=${'Test User'} -c committer.email=${'test@example.com'} commit --no-verify -m ${'Submodule pick commit'}`;
         const subCommit = (
            await $`${gitExe} -C ${forkSubmodulePath} rev-parse HEAD`
         ).stdout.trim();

         const pickCtx = createGdxContext(originSubmodulePath, [
            'parallel',
            'pick',
            alias,
            subCommit,
         ]);
         expect(await parallel(pickCtx)).toBe(0);

         expect(fs.readFileSync(path.join(originSubmodulePath, 'pick-sub.txt'), 'utf-8')).toBe(
            'sub pick'
         );
         const originSubLog = (
            await $`${gitExe} -C ${originSubmodulePath} log -1 --format=%s`
         ).stdout.trim();
         expect(originSubLog).toBe('Submodule pick commit');

         await $`${gitExe} -C ${forkPath} add ${submodulePath}`;
         await $`${gitExe} -C ${forkPath} -c user.name=${'Test User'} -c user.email=${'test@example.com'} -c committer.name=${'Test User'} -c committer.email=${'test@example.com'} commit --no-verify -m ${'Record submodule pick'}`;

         const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', alias]);
         const removeResult = await parallel(removeCtx);
         if (removeResult !== 0) {
            expect(isSubmoduleRemovalBlockedError(buffer.stderr)).toBe(true);
            await forceRemoveWorktreePath(forkPath);
         }
         await $`${gitExe} -C ${tmpDir} -c protocol.file.allow=always submodule update --init --force -- ${submodulePath}`;
         await $`${gitExe} -C ${originSubmodulePath} clean -fd`;
      },
      { timeout: 20000 }
   );

   it('should drop already-applied fork changes while joining the remaining commits', async () => {
      resetCache();
      const alias = 'feature-join-cursor';

      await $`${git$} commit --allow-empty --no-verify -m ${'Cursor base'}`;
      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias, '--no-init']);
      expect(await parallel(forkCtx)).toBe(0);

      const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
      const forkPath = getParallelForkPath(tmpRootDir, tmpDir, alias, branchName);
      const forkGit$ = [Array.isArray(git$) ? git$[0] : git$, '-C', forkPath];

      fs.writeFileSync(path.join(tmpDir, 'cursor-conflict.txt'), 'origin\n');
      await $`${git$} add cursor-conflict.txt`;
      await $`${git$} commit --no-verify -m ${'Origin cursor conflict'}`;

      fs.writeFileSync(path.join(forkPath, 'cursor-a.txt'), 'a');
      await $`${forkGit$} add cursor-a.txt`;
      await $`${forkGit$} commit --no-verify -m ${'Cursor A'}`;

      fs.writeFileSync(path.join(forkPath, 'cursor-shared.txt'), 'shared\n');
      await $`${forkGit$} add cursor-shared.txt`;
      await $`${forkGit$} commit --no-verify -m ${'Cursor B shared'}`;

      fs.writeFileSync(path.join(tmpDir, 'cursor-shared.txt'), 'shared\n');
      await $`${git$} add cursor-shared.txt`;
      await $`${git$} commit --no-verify -m ${'Origin cursor shared'}`;

      fs.writeFileSync(path.join(forkPath, 'cursor-d.txt'), 'd');
      await $`${forkGit$} add cursor-d.txt`;
      await $`${forkGit$} commit --no-verify -m ${'Cursor D'}`;

      const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', alias, '--keep']);
      expect(await parallel(joinCtx)).toBe(0);

      const metaPath = path.join(forkPath, '.git-parallel.json');
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as { joinCursor?: string };
      expect(meta.joinCursor).toBeUndefined();

      const finalForkHead = (await $`${forkGit$} rev-parse HEAD`).stdout.trim();
      const finalOriginHead = (await $`${git$} rev-parse HEAD`).stdout.trim();
      expect(finalForkHead).toBe(finalOriginHead);

      buffer.stdout = '';
      const listCtx = createGdxContext(tmpDir, ['parallel', 'list']);
      expect(await parallel(listCtx)).toBe(0);
      const output = stripAnsiColor(buffer.stdout.replace(/\r/g, ''));
      expect(output).not.toContain('Cursor B shared');

      const originSubjects = (await $`${git$} log --format=%s`).stdout;
      expect(originSubjects).toContain('Cursor A');
      expect(originSubjects).toContain('Cursor D');
      expect(originSubjects).not.toContain('Cursor B shared');

      const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', alias]);
      expect(await parallel(removeCtx)).toBe(0);
   }, { timeout: 20000 });

   it('should leave a rebase conflict in the fork and keep origin unchanged', async () => {
      const previousTTY = env.isTTY;
      env.isTTY = false;
      let forkPath = '';
      try {
         await $`${git$} commit --allow-empty -m ${'Base commit'}`;

         fs.writeFileSync(path.join(tmpDir, 'conflict.txt'), 'base\n');
         await $`${git$} add conflict.txt`;
         await $`${git$} commit --no-verify -m ${'Conflict base'}`;

         const alias = 'feature-rebase-conflict';
         const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias, '--no-init']);
         expect(await parallel(forkCtx)).toBe(0);

         const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
         forkPath = getParallelForkPath(tmpRootDir, tmpDir, alias, branchName);

         fs.writeFileSync(path.join(forkPath, 'conflict.txt'), 'fork-change\n');
         await $`${git$} -C ${forkPath} add conflict.txt`;
         await $`${git$} -C ${forkPath} commit --no-verify -m ${'Fork change'}`;

         fs.writeFileSync(path.join(tmpDir, 'conflict.txt'), 'origin-change\n');
         await $`${git$} add conflict.txt`;
         await $`${git$} commit --no-verify -m ${'Origin change'}`;
         const originHeadBeforeJoin = (await $`${git$} rev-parse HEAD`).stdout.trim();

         const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', alias]);
         const joinResult = await parallel(joinCtx);

         expect(joinResult).toBe(1);
         expect(fs.existsSync(forkPath)).toBe(true);
         const originHeadAfterJoin = (await $`${git$} -C ${tmpDir} rev-parse HEAD`).stdout.trim();
         expect(originHeadAfterJoin).toBe(originHeadBeforeJoin);

         let rebaseHead = '';
         try {
            rebaseHead = (await $`${git$} -C ${forkPath} rev-parse -q --verify REBASE_HEAD`).stdout.trim();
         } catch {
            // The assertion below reports a missing rebase state clearly.
         }
         expect(rebaseHead).not.toBe('');
         const instructions = stripAnsiColor(`${buffer.stdout}\n${buffer.stderr}`).toLowerCase();
         expect(instructions).toContain('rebase --continue');
         expect(instructions).toContain('rebase --abort');
      } finally {
         if (forkPath && fs.existsSync(forkPath)) {
            try {
               await $`${git$} -C ${forkPath} rebase --abort`;
            } catch {
               // Best effort cleanup if the implementation already aborted the rebase.
            }
            await forceRemoveWorktreePath(forkPath);
         }
         try {
            await $`${git$} -C ${tmpDir} rebase --abort`;
         } catch {
            // Compatibility cleanup for the pre-rebase implementation.
         }
         try {
            await $`${git$} -C ${tmpDir} cherry-pick --abort`;
         } catch {
            // Compatibility cleanup for the pre-rebase implementation.
         }
         env.isTTY = previousTTY;
      }
   }, { timeout: 20000 });

   it('should finish a conflicted --all join with its saved changes on retry', async () => {
      resetCache();
      const alias = 'feature-rebase-all-conflict';
      let forkPath = '';
      try {
         fs.writeFileSync(path.join(tmpDir, 'all-conflict.txt'), 'base\n');
         await $`${git$} add all-conflict.txt`;
         await $`${git$} commit --no-verify -m ${'All conflict base'}`;

         const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias, '--no-init']);
         expect(await parallel(forkCtx)).toBe(0);
         const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
         forkPath = getParallelForkPath(tmpRootDir, tmpDir, alias, branchName);

         fs.writeFileSync(path.join(forkPath, 'all-conflict.txt'), 'fork\n');
         await $`${git$} -C ${forkPath} add all-conflict.txt`;
         await $`${git$} -C ${forkPath} commit --no-verify -m ${'All conflict fork'}`;
         fs.writeFileSync(path.join(forkPath, 'all-pending.txt'), 'pending\n');
         await $`${git$} -C ${forkPath} add all-pending.txt`;

         fs.writeFileSync(path.join(tmpDir, 'all-conflict.txt'), 'origin\n');
         await $`${git$} add all-conflict.txt`;
         await $`${git$} commit --no-verify -m ${'All conflict origin'}`;
         const originHead = (await $`${git$} rev-parse HEAD`).stdout.trim();

         const firstJoinCtx = createGdxContext(tmpDir, ['parallel', 'join', alias, '--all']);
         expect(await parallel(firstJoinCtx)).toBe(1);
         expect((await $`${git$} rev-parse HEAD`).stdout.trim()).toBe(originHead);

         const metaPath = path.join(forkPath, '.git-parallel.json');
         const pendingMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as {
            pendingJoinStash?: string;
         };
         expect(pendingMeta.pendingJoinStash).toBeTruthy();

         fs.writeFileSync(path.join(forkPath, 'all-conflict.txt'), 'resolved\n');
         await $`${git$} -C ${forkPath} add all-conflict.txt`;
         await $`${git$} -c core.editor=${'true'} -C ${forkPath} rebase --continue`;

         const retryJoinCtx = createGdxContext(tmpDir, ['parallel', 'join', alias]);
         expect(await parallel(retryJoinCtx)).toBe(0);
         expect(fs.existsSync(forkPath)).toBe(false);
         expect(fs.readFileSync(path.join(tmpDir, 'all-pending.txt'), 'utf-8')).toBe('pending\n');
         expect((await $`${git$} status --porcelain=v1 -- all-pending.txt`).stdout.trim()).toMatch(
            /^A\s+all-pending\.txt$/
         );
      } finally {
         if (forkPath && fs.existsSync(forkPath)) {
            try {
               await $`${git$} -C ${forkPath} rebase --abort`;
            } catch {
               // Best effort cleanup.
            }
            await forceRemoveWorktreePath(forkPath);
         }
         await $`${git$} -C ${tmpDir} reset --hard HEAD`;
      }
   }, { timeout: 30000 });

   it('should refuse sync and removal while a conflicted --all recovery stash is pending', async () => {
      resetCache();
      const alias = 'feature-pending-recovery-guard';
      let forkPath = '';
      try {
         ({ forkPath } = await createPendingJoinStash(alias));

         buffer.stderr = '';
         const syncCtx = createGdxContext(tmpDir, ['parallel', 'sync', alias]);
         expect(await parallel(syncCtx)).toBe(1);
         expect(stripAnsiColor(buffer.stderr).toLowerCase()).toContain('pending');

         const pendingMeta = JSON.parse(
            fs.readFileSync(path.join(forkPath, '.git-parallel.json'), 'utf-8')
         ) as { pendingJoinStash?: string };
         expect(pendingMeta.pendingJoinStash).toBeTruthy();

         buffer.stderr = '';
         const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', alias]);
         expect(await parallel(removeCtx)).toBe(1);
         expect(stripAnsiColor(buffer.stderr).toLowerCase()).toContain('pending');
         expect(fs.existsSync(forkPath)).toBe(true);

         await $`${git$} -C ${forkPath} rebase --abort`;
         buffer.stdout = '';
         buffer.stderr = '';
         const restoreCtx = createGdxContext(tmpDir, ['parallel', 'sync', alias]);
         expect(await parallel(restoreCtx)).toBe(1);
         expect(stripAnsiColor(buffer.stdout).toLowerCase()).toContain('restored');
         const restoredMeta = JSON.parse(
            fs.readFileSync(path.join(forkPath, '.git-parallel.json'), 'utf-8')
         ) as { pendingJoinStash?: string };
         expect(restoredMeta.pendingJoinStash).toBeUndefined();
         expect(fs.existsSync(path.join(forkPath, `${alias}-pending.txt`))).toBe(true);
      } finally {
         if (forkPath && fs.existsSync(forkPath)) {
            try {
               await $`${git$} -C ${forkPath} rebase --abort`;
            } catch {
               // Best effort cleanup.
            }
            await forceRemoveWorktreePath(forkPath);
         }
         await $`${git$} -C ${tmpDir} reset --hard HEAD`;
      }
   }, { timeout: 30000 });

   it(
      'should list commits grouped by submodule',
      async () => {
         resetCache();
         const gitExe = Array.isArray(git$) ? git$[0] : git$;
         const submoduleRoot = path.join(tmpRootDir, 'submodule-list');
         fs.mkdirSync(submoduleRoot, { recursive: true });
         await $`${gitExe} -C ${submoduleRoot} init`;
         await setTestGitConfig(submoduleRoot, 'user.name', 'Test User');
         await setTestGitConfig(submoduleRoot, 'user.email', 'test@example.com');
         await $`${gitExe} -C ${submoduleRoot} commit --allow-empty --no-verify -m ${'init submodule'}`;

         const submoduleUrl = asUnixPath(submoduleRoot);
         const submodulePath = 'deps/submodule-list';
         await addSubmodule(git$, tmpDir, submoduleUrl, submodulePath);
         await $`${gitExe} -C ${tmpDir} add .gitmodules ${submodulePath}`;
         await $`${gitExe} -C ${tmpDir} commit --no-verify -m ${'Add submodule'}`;

         const alias = 'feature-sub-list';
         const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias]);

         const [forkResult, branchName] = await Promise.all([
            parallel(forkCtx),
            $`${git$} rev-parse --abbrev-ref HEAD`.then((child) => child.stdout.trim()),
            async () => {
               const originSubmodulePath = path.join(tmpDir, 'deps', 'submodule-list');
               await setTestGitConfig(originSubmodulePath, 'user.name', 'Test User');
               await setTestGitConfig(originSubmodulePath, 'user.email', 'test@example.com');
            },
         ]);
         expect(forkResult).toBe(0);

         const projectName = path.basename(tmpDir);
         const worktreeRoot = path.join(
            tmpRootDir,
            'tmp',
            'worktrees',
            normalizePath(projectName),
            normalizePath(branchName)
         );
         const forkPath = path.join(worktreeRoot, alias);

         await updateSubmodules(git$, forkPath, { recursive: true });
         const forkSubmodulePath = path.join(forkPath, 'deps', 'submodule-list');

         fs.writeFileSync(path.join(forkSubmodulePath, 'change.txt'), 'sub-change');
         await $`${gitExe} -C ${forkSubmodulePath} add change.txt`;
         await $`${gitExe} -C ${forkSubmodulePath} -c user.name=${'Test User'} -c user.email=${'test@example.com'} -c committer.name=${'Test User'} -c committer.email=${'test@example.com'} commit -m ${'Submodule change'}`;

         await $`${gitExe} -C ${forkPath} add ${submodulePath}`;
         await $`${gitExe} -C ${forkPath} -c user.name=${'Test User'} -c user.email=${'test@example.com'} -c committer.name=${'Test User'} -c committer.email=${'test@example.com'} commit -m ${'Bump submodule'}`;

         fs.writeFileSync(path.join(forkPath, 'main.txt'), 'main');
         await $`${gitExe} -C ${forkPath} add main.txt`;
         await $`${gitExe} -C ${forkPath} commit --no-verify -m ${'Main change'}`;

         resetCache();
         const listCtx = createGdxContext(tmpDir, ['parallel', 'list']);
         expect(await parallel(listCtx)).toBe(0);

         const output = buffer.stdout.replace(/\r/g, '');
         expect(output).toContain('main');
         expect(output).toContain('deps/submodule-list [submodule]');
         expect(output).toContain('Main change');
         expect(output).toContain('Bump submodule');
         expect(output).toContain('Submodule change');

         const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', alias]);
         const removeResult = await parallel(removeCtx);
         if (removeResult !== 0) {
            expect(isSubmoduleRemovalBlockedError(buffer.stderr)).toBe(true);
            await forceRemoveWorktreePath(forkPath);
         }

         await resetRepo('worktree');
      },
      { timeout: 20000 }
   );

   it(
      'should list commits consistently with join cursor for submodules',
      async () => {
         resetCache();
         const gitExe = Array.isArray(git$) ? git$[0] : git$;
         const submoduleRoot = path.join(tmpRootDir, 'submodule-list-cursor');
         fs.mkdirSync(submoduleRoot, { recursive: true });
         await $`${gitExe} -C ${submoduleRoot} init`;
         await setTestGitConfig(submoduleRoot, 'user.name', 'Test User');
         await setTestGitConfig(submoduleRoot, 'user.email', 'test@example.com');
         fs.writeFileSync(path.join(submoduleRoot, 'README.md'), 'submodule');
         await $`${gitExe} -C ${submoduleRoot} add README.md`;
         await $`${gitExe} -C ${submoduleRoot} commit -m ${'init submodule'}`;

         const submoduleUrl = asUnixPath(submoduleRoot);
         const submodulePath = 'deps/submodule-list-cursor';
         await addSubmodule(git$, tmpDir, submoduleUrl, submodulePath);
         await $`${gitExe} -C ${tmpDir} add .gitmodules ${submodulePath}`;
         await $`${gitExe} -C ${tmpDir} commit -m ${'Add submodule'}`;

         const alias = 'feature-sub-list-cursor';
         const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias]);
         const [forkResult, branchName] = await Promise.all([
            parallel(forkCtx),
            $`${git$} rev-parse --abbrev-ref HEAD`.then((child) => child.stdout.trim()),
         ]);
         expect(forkResult).toBe(0);

         const projectName = path.basename(tmpDir);
         const worktreeRoot = path.join(
            tmpRootDir,
            'tmp',
            'worktrees',
            normalizePath(projectName),
            normalizePath(branchName)
         );
         const forkPath = path.join(worktreeRoot, alias);

         await updateSubmodules(git$, forkPath, { recursive: true });
         const forkSubmodulePath = path.join(forkPath, 'deps', 'submodule-list-cursor');

         fs.writeFileSync(path.join(forkSubmodulePath, 'change-1.txt'), 'sub-change-1');
         await $`${gitExe} -C ${forkSubmodulePath} add change-1.txt`;
         await $`${gitExe} -C ${forkSubmodulePath} -c user.name=${'Test User'} -c user.email=${'test@example.com'} -c committer.name=${'Test User'} -c committer.email=${'test@example.com'} commit --no-verify -m ${'Submodule change 1'}`;

         await $`${gitExe} -C ${forkPath} add ${submodulePath}`;
         await $`${gitExe} -C ${forkPath} -c user.name=${'Test User'} -c user.email=${'test@example.com'} -c committer.name=${'Test User'} -c committer.email=${'test@example.com'} commit --no-verify -m ${'Bump submodule 1'}`;

         fs.writeFileSync(path.join(forkPath, 'main-1.txt'), 'main-1');
         await $`${gitExe} -C ${forkPath} add main-1.txt`;
         await $`${gitExe} -C ${forkPath} commit --no-verify -m ${'Main change 1'}`;

         fs.writeFileSync(path.join(forkSubmodulePath, 'change-2.txt'), 'sub-change-2');
         await $`${gitExe} -C ${forkSubmodulePath} add change-2.txt`;
         await $`${gitExe} -C ${forkSubmodulePath} -c user.name=${'Test User'} -c user.email=${'test@example.com'} -c committer.name=${'Test User'} -c committer.email=${'test@example.com'} commit --no-verify -m ${'Submodule change 2'}`;

         await $`${gitExe} -C ${forkPath} add ${submodulePath}`;
         await $`${gitExe} -C ${forkPath} -c user.name=${'Test User'} -c user.email=${'test@example.com'} -c committer.name=${'Test User'} -c committer.email=${'test@example.com'} commit --no-verify -m ${'Bump submodule 2'}`;

         const metaPath = path.join(forkPath, '.git-parallel.json');
         const metaRaw = fs.readFileSync(metaPath, 'utf-8');
         const metaObj = JSON.parse(metaRaw) as { joinCursor?: string };
         metaObj.joinCursor = (await $`${gitExe} -C ${forkPath} rev-parse HEAD~1`).stdout.trim();
         fs.writeFileSync(metaPath, JSON.stringify(metaObj, null, 2), 'utf-8');

         resetCache();
         const listCtx = createGdxContext(tmpDir, ['parallel', 'list']);
         expect(await parallel(listCtx)).toBe(0);
         const output = buffer.stdout.replace(/\r/g, '');

         expect(output).not.toContain('Main change 1');
         expect(output).not.toContain('Bump submodule 1');
         expect(output).toContain('Bump submodule 2');
         expect(output).toContain('Submodule change 2');
         expect(output).toContain('Submodule change 1');

         const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', alias]);
         const removeResult = await parallel(removeCtx);
         if (removeResult !== 0) {
            expect(isSubmoduleRemovalBlockedError(buffer.stderr)).toBe(true);
            await forceRemoveWorktreePath(forkPath);
         }

         await resetRepo('worktree');
      },
      { timeout: 20000 }
   );

   it(
      'should align commit counter with listed commits',
      async () => {
         resetCache();
         const gitExe = Array.isArray(git$) ? git$[0] : git$;
         const submoduleRoot = path.join(tmpRootDir, 'submodule-counter');
         fs.mkdirSync(submoduleRoot, { recursive: true });
         await $`${gitExe} -C ${submoduleRoot} init`;
         await setTestGitConfig(submoduleRoot, 'user.name', 'Test User');
         await setTestGitConfig(submoduleRoot, 'user.email', 'test@example.com');
         await $`${gitExe} -C ${submoduleRoot} commit --allow-empty --no-verify -m ${'init submodule'}`;

         const submoduleUrl = asUnixPath(submoduleRoot);
         const submodulePath = 'deps/submodule-counter';
         await addSubmodule(git$, tmpDir, submoduleUrl, submodulePath);
         await $`${gitExe} -C ${tmpDir} add .gitmodules ${submodulePath}`;
         await $`${gitExe} -C ${tmpDir} commit --no-verify -m ${'Add submodule'}`;

         const alias = 'feature-counter';
         const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias]);
         expect(await parallel(forkCtx)).toBe(0);

         const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
         const projectName = path.basename(tmpDir);
         const worktreeRoot = path.join(
            tmpRootDir,
            'tmp',
            'worktrees',
            normalizePath(projectName),
            normalizePath(branchName)
         );
         const forkPath = path.join(worktreeRoot, alias);

         await updateSubmodules(git$, forkPath, { recursive: true });
         const forkSubmodulePath = path.join(forkPath, 'deps', 'submodule-counter');

         fs.writeFileSync(path.join(forkSubmodulePath, 'change-1.txt'), 'sub-change-1');
         await $`${gitExe} -C ${forkSubmodulePath} add change-1.txt`;
         await $`${gitExe} -C ${forkSubmodulePath} -c user.name=${'Test User'} -c user.email=${'test@example.com'} -c committer.name=${'Test User'} -c committer.email=${'test@example.com'} commit --no-verify -m ${'Submodule change 1'}`;

         await $`${gitExe} -C ${forkPath} add ${submodulePath}`;
         await $`${gitExe} -C ${forkPath} -c user.name=${'Test User'} -c user.email=${'test@example.com'} -c committer.name=${'Test User'} -c committer.email=${'test@example.com'} commit --no-verify -m ${'Bump submodule 1'}`;

         fs.writeFileSync(path.join(forkSubmodulePath, 'change-2.txt'), 'sub-change-2');
         await $`${gitExe} -C ${forkSubmodulePath} add change-2.txt`;
         await $`${gitExe} -C ${forkSubmodulePath} -c user.name=${'Test User'} -c user.email=${'test@example.com'} -c committer.name=${'Test User'} -c committer.email=${'test@example.com'} commit --no-verify -m ${'Submodule change 2'}`;

         await $`${gitExe} -C ${forkPath} add ${submodulePath}`;
         await $`${gitExe} -C ${forkPath} -c user.name=${'Test User'} -c user.email=${'test@example.com'} -c committer.name=${'Test User'} -c committer.email=${'test@example.com'} commit --no-verify -m ${'Bump submodule 2'}`;

         resetCache();
         const listCtx = createGdxContext(tmpDir, ['parallel', 'list']);
         expect(await parallel(listCtx)).toBe(0);
         const output = stripAnsiColor(buffer.stdout.replace(/\r/g, ''));
         const counter = output.match(/feature-counter[\s\S]*?↑(\d+)\+(\d+)/);
         expect(counter).toBeTruthy();
         const numbers = counter?.slice(1, 3) ?? [];
         const mainCount = Number(numbers[0] || 0);
         const subCount = Number(numbers[1] || 0);
         expect(mainCount).toBe(2);
         expect(subCount).toBe(2);

         const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', alias]);
         const removeResult = await parallel(removeCtx);
         if (removeResult !== 0) {
            expect(isSubmoduleRemovalBlockedError(buffer.stderr)).toBe(true);
            await forceRemoveWorktreePath(forkPath);
         }

         await resetRepo('worktree');
      },
      { timeout: 20000 }
   );

   it(
      'should join submodule commits and update the origin gitlink',
      async () => {
         resetCache();
         const gitExe = Array.isArray(git$) ? git$[0] : git$;
         let forkPath = '';
         const submoduleRoot = path.join(tmpRootDir, 'submodule-join');
         fs.mkdirSync(submoduleRoot, { recursive: true });
         await $`${gitExe} -C ${submoduleRoot} init`;
         await setTestGitConfig(submoduleRoot, 'user.name', 'Test User');
         await setTestGitConfig(submoduleRoot, 'user.email', 'test@example.com');
         await $`${gitExe} -C ${submoduleRoot} commit --allow-empty --no-verify -m ${'init submodule'}`;

         const submoduleUrl = asUnixPath(submoduleRoot);
         const submodulePath = 'deps/submodule-join';
         await addSubmodule(git$, tmpDir, submoduleUrl, submodulePath);
         await $`${gitExe} -C ${tmpDir} add .gitmodules ${submodulePath}`;
         await $`${gitExe} -C ${tmpDir} commit --no-verify -m ${'Add submodule'}`;
         const originSubmodulePath = path.join(tmpDir, 'deps', 'submodule-join');
         await setTestGitConfig(originSubmodulePath, 'user.name', 'Test User');
         await setTestGitConfig(originSubmodulePath, 'user.email', 'test@example.com');

         try {
            const alias = 'feature-sub-join';
            const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias]);
            expect(await parallel(forkCtx)).toBe(0);

            const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
            const projectName = path.basename(tmpDir);
            const worktreeRoot = path.join(
               tmpRootDir,
               'tmp',
               'worktrees',
               normalizePath(projectName),
               normalizePath(branchName)
            );
            forkPath = path.join(worktreeRoot, alias);

            await updateSubmodules(git$, forkPath, { recursive: true });
            const forkSubmodulePath = path.join(forkPath, 'deps', 'submodule-join');

            fs.writeFileSync(path.join(forkSubmodulePath, 'join-change.txt'), 'sub-join');
            await $`${gitExe} -C ${forkSubmodulePath} add join-change.txt`;
            await $`${gitExe} -C ${forkSubmodulePath} -c user.name=${'Test User'} -c user.email=${'test@example.com'} -c committer.name=${'Test User'} -c committer.email=${'test@example.com'} commit --no-verify -m ${'Submodule join change'}`;

            await $`${gitExe} -C ${forkPath} add ${submodulePath}`;
            await $`${gitExe} -C ${forkPath} -c user.name=${'Test User'} -c user.email=${'test@example.com'} -c committer.name=${'Test User'} -c committer.email=${'test@example.com'} commit --no-verify -m ${'Bump submodule for join'}`;

            const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', alias]);
            const joinResult = await parallel(joinCtx);
            expect([0, 1]).toContain(joinResult);
            if (joinResult !== 0) {
               expect(isSubmoduleRemovalBlockedError(buffer.stderr)).toBe(true);
            }

            const submoduleLog = (
               await $`${gitExe} -C ${originSubmodulePath} log -1 --format=%s`
            ).stdout.trim();
            expect(submoduleLog).toBe('Submodule join change');

            const originSubmoduleHead = (
               await $`${gitExe} -C ${originSubmodulePath} rev-parse HEAD`
            ).stdout.trim();
            const originGitlink = (
               await $`${gitExe} -C ${tmpDir} ls-tree HEAD -- ${submodulePath}`
            ).stdout.trim();
            expect(originGitlink).toContain(`${originSubmoduleHead}\t${submodulePath}`);

            const originLog = (await $`${gitExe} -C ${tmpDir} log --format=%s`).stdout.trim();
            expect(originLog).toContain('Bump submodule for join');
         } finally {
            if (forkPath) {
               await forceRemoveWorktreePath(forkPath);
            }
            await resetRepo('worktree');
         }
      },
      { timeout: 20000 }
   );

   it(
      'should ignore missing origin submodule head during join preview',
      async () => {
         resetCache();
         const gitExe = Array.isArray(git$) ? git$[0] : git$;
         const previousTTY = env.isTTY;
         let forkPath = '';
         let originGitMarker = '';
         let originGitMarkerContent: string | null = null;
         const submoduleRoot = path.join(tmpRootDir, 'submodule-missing-origin');
         fs.mkdirSync(submoduleRoot, { recursive: true });
         await $`${gitExe} -C ${submoduleRoot} init`;
         await setTestGitConfig(submoduleRoot, 'user.name', 'Test User');
         await setTestGitConfig(submoduleRoot, 'user.email', 'test@example.com');
         await $`${gitExe} -C ${submoduleRoot} commit --allow-empty --no-verify -m ${'init submodule'}`;

         const submoduleUrl = asUnixPath(submoduleRoot);
         const submodulePath = 'deps/submodule-missing-origin';
         await addSubmodule(git$, tmpDir, submoduleUrl, submodulePath);
         await $`${gitExe} -C ${tmpDir} add .gitmodules ${submodulePath}`;
         await $`${gitExe} -C ${tmpDir} commit --no-verify -m ${'Add submodule'}`;

         const originSubmodulePath = path.join(tmpDir, submodulePath);
         await setTestGitConfig(originSubmodulePath, 'user.name', 'Test User');
         await setTestGitConfig(originSubmodulePath, 'user.email', 'test@example.com');

         try {
            const alias = 'feature-missing-origin';
            const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias]);
            expect(await parallel(forkCtx)).toBe(0);

            const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
            const projectName = path.basename(tmpDir);
            const worktreeRoot = path.join(
               tmpRootDir,
               'tmp',
               'worktrees',
               normalizePath(projectName),
               normalizePath(branchName)
            );
            forkPath = path.join(worktreeRoot, alias);

            await updateSubmodules(git$, forkPath, { recursive: true });

            const altRepoRoot = path.join(tmpRootDir, 'submodule-missing-origin-alt');
            fs.mkdirSync(altRepoRoot, { recursive: true });
            await $`${gitExe} -C ${altRepoRoot} init`;
            await setTestGitConfig(altRepoRoot, 'user.name', 'Test User');
            await setTestGitConfig(altRepoRoot, 'user.email', 'test@example.com');
            await $`${gitExe} -C ${altRepoRoot} commit --no-verify --allow-empty -m ${'Alt commit'}`;

            const altGitDirRaw = (
               await $`${gitExe} -C ${altRepoRoot} rev-parse --git-dir`
            ).stdout.trim();
            const altGitDir = path.isAbsolute(altGitDirRaw)
               ? altGitDirRaw
               : path.join(altRepoRoot, altGitDirRaw);
            originGitMarker = path.join(originSubmodulePath, '.git');
            const markerStat = await fs.stat(originGitMarker);
            expect(markerStat.isFile()).toBe(true);
            originGitMarkerContent = fs.readFileSync(originGitMarker, 'utf-8');
            fs.writeFileSync(originGitMarker, `gitdir: ${asUnixPath(altGitDir)}`);

            buffer.stdout = '';
            env.isTTY = false;
            const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', alias, '--keep']);
            expect(await parallel(joinCtx)).toBe(0);

            expect(buffer.stdout).not.toContain('Unable to enumerate submodule commits');
         } finally {
            if (originGitMarker && originGitMarkerContent !== null) {
               fs.writeFileSync(originGitMarker, originGitMarkerContent, 'utf-8');
            }
            if (forkPath) {
               await forceRemoveWorktreePath(forkPath);
            }
            env.isTTY = previousTTY;
            await resetRepo('worktree');
         }
      },
      { timeout: 20000 }
   );

   it('should treat duplicate fork changes as a clean join', async () => {
      resetCache();
      const alias = 'feature-empty';
      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias, '--no-init']);
      expect(await parallel(forkCtx)).toBe(0);

      const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
      const projectName = path.basename(tmpDir);
      const worktreeRoot = path.join(
         tmpRootDir,
         'tmp',
         'worktrees',
         normalizePath(projectName),
         normalizePath(branchName)
      );
      const forkPath = path.join(worktreeRoot, alias);
      const gitExec = Array.isArray(git$) ? git$[0] : git$;
      const forkGit$ = [gitExec, '-C', forkPath];

      fs.writeFileSync(path.join(forkPath, 'duplicate.txt'), 'duplicate');
      await $`${forkGit$} add duplicate.txt`;
      await $`${forkGit$} commit --no-verify -m ${'Duplicate change'}`;
      await $`${forkGit$} reset --hard HEAD`;

      fs.writeFileSync(path.join(tmpDir, 'duplicate.txt'), 'duplicate');
      await $`${git$} -C ${tmpDir} add duplicate.txt`;
      await $`${git$} -C ${tmpDir} -c user.name=${'Test User'} -c user.email=${'test@example.com'} -c committer.name=${'Test User'} -c committer.email=${'test@example.com'} commit --no-verify -m ${'Duplicate change origin'}`;

      const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', alias]);
      const joinResult = await parallel(joinCtx);
      expect(joinResult).toBe(0);

      const forkExists = await fs
         .stat(forkPath)
         .then(() => true)
         .catch(() => false);
      expect(forkExists).toBe(false);

      if (forkExists) {
         const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', alias]);
         expect(await parallel(removeCtx)).toBe(0);
      }
   });

   it(
      'should leave an up-to-date fork unchanged when joining',
      async () => {
         resetCache();
         const alias = 'feature-join-skip';
         const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias]);
         expect(await parallel(forkCtx)).toBe(0);

         const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
         const projectName = path.basename(tmpDir);
         const worktreeRoot = path.join(
            tmpRootDir,
            'tmp',
            'worktrees',
            normalizePath(projectName),
            normalizePath(branchName)
         );
         const forkPath = path.join(worktreeRoot, alias);
         const gitExec = Array.isArray(git$) ? git$[0] : git$;
         const forkGit$ = [gitExec, '-C', forkPath];

         fs.writeFileSync(path.join(forkPath, 'join-skip.txt'), 'join-skip');
         await $`${forkGit$} add join-skip.txt`;
         await $`${forkGit$} commit --no-verify -m ${'Join skip commit'}`;

         const forkHead = (await $`${git$} -C ${forkPath} rev-parse HEAD`).stdout.trim();
         await $`${git$} -C ${tmpDir} merge --no-edit ${forkHead}`;

         resetCache();
         const listCtx = createGdxContext(tmpDir, ['parallel', 'list']);
         expect(await parallel(listCtx)).toBe(0);
         const listOutput = stripAnsiColor(buffer.stdout.replace(/\r/g, ''));
         expect(listOutput).toContain('up-to-date');
         expect(listOutput).not.toContain('Join skip commit');

         buffer.stdout = '';
         const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', alias, '--keep']);
         const joinResult = await parallel(joinCtx);

         expect(joinResult).toBe(0);
         expect(buffer.stdout.toLowerCase()).toContain('already up to date');
         expect(buffer.stdout).not.toContain('Join skip commit');

         const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', alias]);
         expect(await parallel(removeCtx)).toBe(0);
      },
      { timeout: 15000 }
   );

   it(
      'should apply submodule commits in non-interactive join for branch worktree',
      async () => {
         resetCache();
         const gitExe = Array.isArray(git$) ? git$[0] : git$;
         let forkPath = '';
         const submoduleRoot = path.join(tmpRootDir, 'submodule-branch-join');
         fs.mkdirSync(submoduleRoot, { recursive: true });
         await $`${gitExe} -C ${submoduleRoot} init`;
         await setTestGitConfig(submoduleRoot, 'user.name', 'Test User');
         await setTestGitConfig(submoduleRoot, 'user.email', 'test@example.com');
         fs.writeFileSync(path.join(submoduleRoot, 'README.md'), 'submodule');
         await $`${gitExe} -C ${submoduleRoot} add README.md`;
         await $`${gitExe} -C ${submoduleRoot} commit -m ${'init submodule'}`;

         const submoduleUrl = asUnixPath(submoduleRoot);
         const submodulePath = 'deps/submodule-branch-join';
         await addSubmodule(git$, tmpDir, submoduleUrl, submodulePath);
         await $`${gitExe} -C ${tmpDir} add .gitmodules ${submodulePath}`;
         await $`${gitExe} -C ${tmpDir} commit -m ${'Add submodule'}`;
         const originSubmodulePath = path.join(tmpDir, submodulePath);
         await setTestGitConfig(originSubmodulePath, 'user.name', 'Test User');
         await setTestGitConfig(originSubmodulePath, 'user.email', 'test@example.com');

         try {
            const alias = 'feature-branch-sub-join';
            const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias, '-b', alias]);
            expect(await parallel(forkCtx)).toBe(0);

            const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
            const projectName = path.basename(tmpDir);
            const worktreeRoot = path.join(
               tmpRootDir,
               'tmp',
               'worktrees',
               normalizePath(projectName),
               normalizePath(branchName)
            );
            forkPath = path.join(worktreeRoot, alias);

            await updateSubmodules(git$, forkPath, { recursive: true });
            const forkSubmodulePath = path.join(forkPath, submodulePath);

            fs.writeFileSync(path.join(forkSubmodulePath, 'branch-join.txt'), 'sub-join');
            await $`${gitExe} -C ${forkSubmodulePath} add branch-join.txt`;
            await $`${gitExe} -C ${forkSubmodulePath} -c user.name=${'Test User'} -c user.email=${'test@example.com'} -c committer.name=${'Test User'} -c committer.email=${'test@example.com'} commit --no-verify -m ${'Submodule branch join change'}`;

            await $`${gitExe} -C ${forkPath} add ${submodulePath}`;
            await $`${gitExe} -C ${forkPath} -c user.name=${'Test User'} -c user.email=${'test@example.com'} -c committer.name=${'Test User'} -c committer.email=${'test@example.com'} commit --no-verify -m ${'Bump submodule for branch join'}`;

            const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', alias]);
            const joinResult = await parallel(joinCtx);
            expect([0, 1]).toContain(joinResult);
            if (joinResult !== 0) {
               expect(isSubmoduleRemovalBlockedError(buffer.stderr)).toBe(true);
            }

            const submoduleLog = (
               await $`${gitExe} -C ${originSubmodulePath} log -1 --format=%s`
            ).stdout.trim();
            expect(submoduleLog).toBe('Submodule branch join change');

            const originLog = (await $`${gitExe} -C ${tmpDir} log --format=%s`).stdout.trim();
            expect(originLog).toContain('Bump submodule for branch join');
         } finally {
            if (forkPath) {
               await forceRemoveWorktreePath(forkPath);
            }
            await resetRepo('worktree');
         }
      },
      { timeout: 20000 }
   );

   it('should remove a duplicate-only fork without leaving status changes', async () => {
      resetCache();
      const alias = 'feature-empty-status';
      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias, '--no-init']);
      expect(await parallel(forkCtx)).toBe(0);

      const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
      const projectName = path.basename(tmpDir);
      const worktreeRoot = path.join(
         tmpRootDir,
         'tmp',
         'worktrees',
         normalizePath(projectName),
         normalizePath(branchName)
      );
      const forkPath = path.join(worktreeRoot, alias);
      const gitExec = Array.isArray(git$) ? git$[0] : git$;
      const forkGit$ = [gitExec, '-C', forkPath];

      fs.writeFileSync(path.join(forkPath, 'duplicate-status.txt'), 'duplicate');
      await $`${forkGit$} add duplicate-status.txt`;
      await $`${forkGit$} commit --no-verify -m ${'Duplicate status change'}`;
      await $`${forkGit$} reset --hard HEAD`;

      fs.writeFileSync(path.join(tmpDir, 'duplicate-status.txt'), 'duplicate');
      await $`${git$} -C ${tmpDir} add duplicate-status.txt`;
      await $`${git$} -C ${tmpDir} -c user.name=${'Test User'} -c user.email=${'test@example.com'} -c committer.name=${'Test User'} -c committer.email=${'test@example.com'} commit --no-verify -m ${'Duplicate status change origin'}`;

      env.isTTY = false;
      const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', alias]);
      const joinResult = await parallel(joinCtx);
      env.isTTY = true;

      expect(joinResult).toBe(0);
      expect(fs.readFileSync(path.join(tmpDir, 'duplicate-status.txt'), 'utf-8')).toBe('duplicate');
      expect(fs.existsSync(forkPath)).toBe(false);
   });
   it('routes top-level -C to parallel pick without changing cwd', async () => {
      const { dispatch } = await import('@/cli/dispatch');

      await $`${git$} commit --allow-empty -m ${'Dispatch base'}`;

      const alias = 'dispatch-pick';
      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias, '--no-init']);
      expect(await parallel(forkCtx)).toBe(0);

      const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
      const forkPath = getParallelForkPath(tmpRootDir, tmpDir, alias, branchName);

      fs.writeFileSync(path.join(tmpDir, 'dispatch-pick.txt'), 'dispatch');
      await $`${git$} add dispatch-pick.txt`;
      await $`${git$} commit --no-verify -m ${'Dispatch pick commit'}`;
      const commit = (await $`${git$} rev-parse HEAD`).stdout.trim();

      const parsed = stripGitGlobalArgs(['-C', forkPath, 'parallel', 'pick', 'origin', commit]);
      const gitExec = Array.isArray(git$) ? git$[0] : git$;
      const ctx = {
         git$: [gitExec, ...parsed.gitArgs],
         args: new ArgsSet(parsed.args),
      };

      expect(await dispatch(ctx)).toBe(0);
      expect(fs.readFileSync(path.join(forkPath, 'dispatch-pick.txt'), 'utf-8')).toBe('dispatch');
      expect(stripAnsiColor(buffer.stdout)).toContain("Cherry-picked 1 commit(s) from 'origin'");

      const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', alias]);
      expect(await parallel(removeCtx)).toBe(0);
   });

   it('routes top-level -C to parallel fork without changing cwd', async () => {
      const { dispatch } = await import('@/cli/dispatch');

      await $`${git$} commit --allow-empty -m ${'Dispatch fork base'}`;

      const alias = 'dispatch-fork';
      const parsed = stripGitGlobalArgs(['-C', tmpDir, 'parallel', 'fork', alias, '--no-init']);
      const gitExec = Array.isArray(git$) ? git$[0] : git$;
      const ctx = {
         git$: [gitExec, ...parsed.gitArgs],
         args: new ArgsSet(parsed.args),
      };

      expect(await dispatch(ctx)).toBe(0);

      const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
      const forkPath = getParallelForkPath(tmpRootDir, tmpDir, alias, branchName);
      expect(fs.existsSync(forkPath)).toBe(true);

      const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', alias]);
      expect(await parallel(removeCtx)).toBe(0);
   });

   it('routes top-level -C to parallel join without changing cwd', async () => {
      const { dispatch } = await import('@/cli/dispatch');

      await $`${git$} commit --allow-empty -m ${'Dispatch join base'}`;

      const alias = 'dispatch-join';
      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias, '--no-init']);
      expect(await parallel(forkCtx)).toBe(0);

      const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
      const forkPath = getParallelForkPath(tmpRootDir, tmpDir, alias, branchName);
      const forkGit$ = [Array.isArray(git$) ? git$[0] : git$, '-C', forkPath];

      fs.writeFileSync(path.join(forkPath, 'dispatch-join.txt'), 'dispatch-join');
      await $`${forkGit$} add dispatch-join.txt`;
      await $`${forkGit$} commit --no-verify -m ${'Dispatch join commit'}`;

      const parsed = stripGitGlobalArgs(['-C', tmpDir, 'parallel', 'join', alias, '--keep']);
      const gitExec = Array.isArray(git$) ? git$[0] : git$;
      const ctx = {
         git$: [gitExec, ...parsed.gitArgs],
         args: new ArgsSet(parsed.args),
      };

      expect(await dispatch(ctx)).toBe(0);
      expect(stripAnsiColor(buffer.stdout)).toContain(
         `Rebased fork '${alias}' and fast-forwarded origin.`
      );
      expect(fs.readFileSync(path.join(tmpDir, 'dispatch-join.txt'), 'utf-8')).toBe(
         'dispatch-join'
      );

      const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', alias]);
      expect(await parallel(removeCtx)).toBe(0);
   });

   it('joins and removes the current fork when no alias is given', async () => {
      resetCache();
      const alias = 'join-current-fork';
      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias, '--no-init']);
      expect(await parallel(forkCtx)).toBe(0);

      const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
      const forkPath = getParallelForkPath(tmpRootDir, tmpDir, alias, branchName);
      fs.writeFileSync(path.join(forkPath, 'join-current.txt'), 'joined\n');
      await $`${git$} -C ${forkPath} add join-current.txt`;
      await $`${git$} -C ${forkPath} commit --no-verify -m ${'Join current fork'}`;

      const joinCtx = createGdxContext(forkPath, ['parallel', 'join']);
      expect(await parallel(joinCtx)).toBe(0);
      expect(fs.existsSync(forkPath)).toBe(false);
      expect(fs.readFileSync(path.join(tmpDir, 'join-current.txt'), 'utf-8')).toBe('joined\n');
   }, { timeout: 20000 });
});
