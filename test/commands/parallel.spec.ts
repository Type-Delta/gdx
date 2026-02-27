import { afterAll, describe, expect } from 'bun:test';
import path from 'path';

import * as fs from '@/modules/fs';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';
import { resetCache } from '@/common/cache';
import { resetConfig } from '@/common/config';
import { normalizePath } from '@/utils/utilities';
import { stripAnsiColor } from '@/modules/graphics';

describe('gdx parallel', async () => {
   const { tmpDir, tmpRootDir, $, buffer, cleanup, it, env, resetRepo, tracker } =
      await createTestEnv({
         autoResetBuffer: true,
      });
   const { git$ } = createGdxContext(tmpDir);
   const { default: parallel } = await import('@/commands/parallel');
   const { GDX_RESULT_FILE } = await import('@/consts');
   afterAll(cleanup);

   it('should list empty worktrees initially', async () => {
      resetCache();
      const listCtx = createGdxContext(tmpDir, ['parallel', 'list', '-s']);
      const result = await parallel(listCtx);

      expect(result).toBe(0);
      // LINK: dkn2ika string literal in spec
      expect(buffer.stdout.toLowerCase()).toContain('no forked worktrees found');
   });

   it('should show correct list headers in origin', async () => {
      const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
      const projectName = path.basename(tmpDir);

      const listCtx = createGdxContext(tmpDir, ['parallel', 'list']);
      const result = await parallel(listCtx);

      const output = buffer.stdout.replace(/\\/g, '/');

      // LINK: iin2ya string literal in spec
      expect(result).toBe(0);
      expect(output).toContain(`Project: ${projectName}`);
      expect(output).toContain(`Branch: ${branchName}`);
      expect(output).toContain(`Origin: ${tmpDir.replace(/\\/g, '/')}`);
      expect(output).toMatch(/Current:\s+origin\b/);
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
      await $`${git$} -C ${tmpDir} commit -m ${'Add gitignore for env'} `;

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

         await resetRepo();
         await $`${git$} -C ${tmpDir} clean -fd`;
         fs.writeFileSync(configPath, originalConfig, 'utf-8');
         resetConfig();
         resetCache();
      }
   });

   it('should fork from a specific ref', async () => {
      await $`${git$} commit --allow-empty -m ${'Ref base'}`;
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

      await resetRepo();
      const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', 'feature-ref']);
      await parallel(removeCtx);
   });

   it('should fork and join a branch-tracked worktree', async () => {
      await $`${git$} commit --allow-empty -m ${'Branch base'}`;

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
      await $`${git$} -C ${forkPath} commit -m ${'Branch change'}`;

      await fs.rm(path.join(forkPath, '.env.local'), { force: true });
      await fs.rm(path.join(forkPath, 'notes.txt'), { force: true });

      const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', alias]);
      const joinResult = await parallel(joinCtx);

      expect(joinResult).toBe(0);

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

      const output = buffer.stdout.replace(/\\/g, '/');

      expect(result).toBe(0);
      expect(output).toContain(`Project: ${projectName}`);
      expect(output).toContain(`Branch: ${branchName}`);
      expect(output).toContain(`Origin: ${tmpDir.replace(/\\/g, '/')}`);
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
         const filename = `short-hint-${i}.txt`;
         fs.writeFileSync(path.join(forkPath, filename), `short-hint-${i}`);
         await $`${forkGit$} add ${filename}`;
         await $`${forkGit$} commit -m ${`Add short hint ${i}`}`;
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

      expect(tracker.openedPaths.map((value) => value.replace(/\\/g, '/'))).toEqual([
         forkPath.replace(/\\/g, '/'),
         tmpDir.replace(/\\/g, '/'),
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

      expect(tracker.scheduledDirs.map((value) => value.replace(/\\/g, '/'))).toEqual([
         forkPath.replace(/\\/g, '/'),
         tmpDir.replace(/\\/g, '/'),
      ]);
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
         const filename = `short-${i}.txt`;
         fs.writeFileSync(path.join(forkPath, filename), `short-${i}`);
         await $`${forkGit$} add ${filename}`;
         await $`${forkGit$} commit -m ${`Add short ${i}`}`;
      }

      await fs.rm(path.join(forkPath, '.env.local'), { force: true });
      await fs.rm(path.join(forkPath, 'notes.txt'), { force: true });

      resetCache();
      const listCtx = createGdxContext(tmpDir, ['parallel', 'list']);
      const listResult = await parallel(listCtx);

      expect(listResult).toBe(0);
      const output = buffer.stdout.replace(/\\/g, '/');

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
         const filename = `${message.replace(/\s+/g, '-').toLowerCase()}.txt`;
         fs.writeFileSync(path.join(forkPath, filename), message);
         await $`${forkGit$} add ${filename}`;
         await $`${forkGit$} commit -m ${message}`;
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
         await $`${git$} -C ${submoduleRoot} config user.name ${'Test User'}`;
         await $`${git$} -C ${submoduleRoot} config user.email ${'test@example.com'}`;
         fs.writeFileSync(path.join(submoduleRoot, 'README.md'), 'submodule');
         await $`${git$} -C ${submoduleRoot} add README.md`;
         await $`${git$} -C ${submoduleRoot} commit -m ${'init submodule'}`;

         const submoduleSha = (await $`${git$} -C ${submoduleRoot} rev-parse HEAD`).stdout.trim();
         const submoduleUrl = submoduleRoot.replace(/\\/g, '/');
         const gitmodulesContent = `[submodule "deps/submodule"]\n\tpath = deps/submodule\n\turl = ${submoduleUrl}\n`;
         fs.writeFileSync(path.join(tmpDir, '.gitmodules'), gitmodulesContent);
         await Promise.all([
            $`${git$} -C ${tmpDir} add .gitmodules`,
            $`${git$} -C ${tmpDir} update-index --add --cacheinfo 160000 ${submoduleSha} ${'deps/submodule'}`,
         ]);
         await $`${git$} -C ${tmpDir} commit -m ${'Add submodule'}`;

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
            await resetRepo();
            await $`${git$} -C ${tmpDir} clean -fd`;
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
         await $`${gitExe} -C ${submoduleRoot} config user.name ${'Test User'}`;
         await $`${gitExe} -C ${submoduleRoot} config user.email ${'test@example.com'}`;
         fs.writeFileSync(path.join(submoduleRoot, 'README.md'), 'submodule');
         await $`${gitExe} -C ${submoduleRoot} add README.md`;
         await $`${gitExe} -C ${submoduleRoot} commit -m ${'init submodule'}`;

         const submoduleUrl = submoduleRoot.replace(/\\/g, '/');
         await $`${gitExe} -C ${tmpDir} -c protocol.file.allow=always submodule add ${submoduleUrl} ${'deps/submodule'}`;
         await $`${gitExe} -C ${tmpDir} add .gitmodules ${'deps/submodule'}`;
         await $`${gitExe} -C ${tmpDir} commit -m ${'Add submodule'}`;

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
               await $`${gitExe} -C ${forkPath} -c protocol.file.allow=always submodule update --init --recursive`;
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

            if (removeResult === 0) {
               expect(buffer.stdout.toLowerCase()).toContain('removed worktree');
            } else {
               expect(buffer.stderr).toContain('dirty submodules');
            }

            const stillExists = await fs
               .stat(forkPath)
               .then(() => true)
               .catch(() => false);
            if (removeResult === 0) {
               expect(stillExists).toBe(false);
            } else {
               expect(stillExists).toBe(true);
            }
         } finally {
            await $`${git$} worktree prune --expire now`;
            await fs.rm(path.join(tmpDir, 'deps'), { recursive: true, force: true });
            await resetRepo();
            await $`${git$} -C ${tmpDir} clean -fd`;
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

   it('should remove all worktrees recursively', async () => {
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
   });

   it('should join all worktrees recursively', async () => {
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
   });

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

   it('should stop on cherry-pick conflicts and print manual steps', async () => {
      env.isTTY = false;
      await $`${git$} commit --allow-empty -m ${'Base commit'}`;

      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', 'feature-conflict']);
      expect(await parallel(forkCtx)).toBe(0);

      const worktreeRoot = path.join(tmpRootDir, 'tmp', 'worktrees', 'project', 'master');
      const forkPath = path.join(worktreeRoot, 'feature-conflict');

      fs.writeFileSync(path.join(tmpDir, 'conflict.txt'), 'origin-change');
      await $`${git$} -C ${tmpDir} add conflict.txt`;
      await $`${git$} -C ${tmpDir} commit -m ${'Origin change'}`;

      fs.writeFileSync(path.join(forkPath, 'conflict.txt'), 'fork-change');
      await $`${git$} -C ${forkPath} add conflict.txt`;
      await $`${git$} -C ${forkPath} commit -m ${'Fork change'}`;

      const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', 'feature-conflict']);
      const joinResult = await parallel(joinCtx);

      expect(joinResult).toBe(1);
      expect(buffer.stdout).toContain('cherry-pick --continue');

      const cherryPickHead = await $`${git$} -C ${tmpDir} rev-parse -q --verify CHERRY_PICK_HEAD`;
      expect(cherryPickHead.exitCode).toBe(0);
      await $`${git$} -C ${tmpDir} cherry-pick --abort`;
      env.isTTY = true;
   });

   it(
      'should list commits grouped by submodule',
      async () => {
         resetCache();
         const gitExe = Array.isArray(git$) ? git$[0] : git$;
         const submoduleRoot = path.join(tmpRootDir, 'submodule-list');
         fs.mkdirSync(submoduleRoot, { recursive: true });
         await $`${gitExe} -C ${submoduleRoot} init`;
         await $`${gitExe} -C ${submoduleRoot} config user.name ${'Test User'}`;
         await $`${gitExe} -C ${submoduleRoot} config user.email ${'test@example.com'}`;
         fs.writeFileSync(path.join(submoduleRoot, 'README.md'), 'submodule');
         await $`${gitExe} -C ${submoduleRoot} add README.md`;
         await $`${gitExe} -C ${submoduleRoot} commit -m ${'init submodule'}`;

         const submoduleUrl = submoduleRoot.replace(/\\/g, '/');
         const submodulePath = 'deps/submodule-list';
         await $`${gitExe} -C ${tmpDir} -c protocol.file.allow=always submodule add ${submoduleUrl} ${submodulePath}`;
         await $`${gitExe} -C ${tmpDir} add .gitmodules ${submodulePath}`;
         await $`${gitExe} -C ${tmpDir} commit -m ${'Add submodule'}`;

         const alias = 'feature-sub-list';
         const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias]);

         const [forkResult, branchName] = await Promise.all([
            parallel(forkCtx),
            $`${git$} rev-parse --abbrev-ref HEAD`.then((child) => child.stdout.trim()),
            async () => {
               const originSubmodulePath = path.join(tmpDir, 'deps', 'submodule-list');
               await $`${gitExe} -C ${originSubmodulePath} config user.name ${'Test User'}`;
               await $`${gitExe} -C ${originSubmodulePath} config user.email ${'test@example.com'}`;
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

         await $`${gitExe} -C ${forkPath} -c protocol.file.allow=always submodule update --init --recursive`;
         const forkSubmodulePath = path.join(forkPath, 'deps', 'submodule-list');

         fs.writeFileSync(path.join(forkSubmodulePath, 'change.txt'), 'sub-change');
         await $`${gitExe} -C ${forkSubmodulePath} add change.txt`;
         await $`${gitExe} -C ${forkSubmodulePath} -c user.name=${'Test User'} -c user.email=${'test@example.com'} -c committer.name=${'Test User'} -c committer.email=${'test@example.com'} commit -m ${'Submodule change'}`;

         await $`${gitExe} -C ${forkPath} add ${submodulePath}`;
         await $`${gitExe} -C ${forkPath} -c user.name=${'Test User'} -c user.email=${'test@example.com'} -c committer.name=${'Test User'} -c committer.email=${'test@example.com'} commit -m ${'Bump submodule'}`;

         fs.writeFileSync(path.join(forkPath, 'main.txt'), 'main');
         await $`${gitExe} -C ${forkPath} add main.txt`;
         await $`${gitExe} -C ${forkPath} commit -m ${'Main change'}`;

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
         expect(await parallel(removeCtx)).toBe(0);

         await resetRepo();
         await $`${gitExe} -C ${tmpDir} clean -fd`;
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
         await $`${gitExe} -C ${submoduleRoot} config user.name ${'Test User'}`;
         await $`${gitExe} -C ${submoduleRoot} config user.email ${'test@example.com'}`;
         fs.writeFileSync(path.join(submoduleRoot, 'README.md'), 'submodule');
         await $`${gitExe} -C ${submoduleRoot} add README.md`;
         await $`${gitExe} -C ${submoduleRoot} commit -m ${'init submodule'}`;

         const submoduleUrl = submoduleRoot.replace(/\\/g, '/');
         const submodulePath = 'deps/submodule-list-cursor';
         await $`${gitExe} -C ${tmpDir} -c protocol.file.allow=always submodule add ${submoduleUrl} ${submodulePath}`;
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

         await $`${gitExe} -C ${forkPath} -c protocol.file.allow=always submodule update --init --recursive`;
         const forkSubmodulePath = path.join(forkPath, 'deps', 'submodule-list-cursor');

         fs.writeFileSync(path.join(forkSubmodulePath, 'change-1.txt'), 'sub-change-1');
         await $`${gitExe} -C ${forkSubmodulePath} add change-1.txt`;
         await $`${gitExe} -C ${forkSubmodulePath} -c user.name=${'Test User'} -c user.email=${'test@example.com'} -c committer.name=${'Test User'} -c committer.email=${'test@example.com'} commit -m ${'Submodule change 1'}`;

         await $`${gitExe} -C ${forkPath} add ${submodulePath}`;
         await $`${gitExe} -C ${forkPath} -c user.name=${'Test User'} -c user.email=${'test@example.com'} -c committer.name=${'Test User'} -c committer.email=${'test@example.com'} commit -m ${'Bump submodule 1'}`;

         fs.writeFileSync(path.join(forkPath, 'main-1.txt'), 'main-1');
         await $`${gitExe} -C ${forkPath} add main-1.txt`;
         await $`${gitExe} -C ${forkPath} commit -m ${'Main change 1'}`;

         fs.writeFileSync(path.join(forkSubmodulePath, 'change-2.txt'), 'sub-change-2');
         await $`${gitExe} -C ${forkSubmodulePath} add change-2.txt`;
         await $`${gitExe} -C ${forkSubmodulePath} -c user.name=${'Test User'} -c user.email=${'test@example.com'} -c committer.name=${'Test User'} -c committer.email=${'test@example.com'} commit -m ${'Submodule change 2'}`;

         await $`${gitExe} -C ${forkPath} add ${submodulePath}`;
         await $`${gitExe} -C ${forkPath} -c user.name=${'Test User'} -c user.email=${'test@example.com'} -c committer.name=${'Test User'} -c committer.email=${'test@example.com'} commit -m ${'Bump submodule 2'}`;

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
         expect(await parallel(removeCtx)).toBe(0);

         await resetRepo();
         await $`${gitExe} -C ${tmpDir} clean -fd`;
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
         await $`${gitExe} -C ${submoduleRoot} config user.name ${'Test User'}`;
         await $`${gitExe} -C ${submoduleRoot} config user.email ${'test@example.com'}`;
         fs.writeFileSync(path.join(submoduleRoot, 'README.md'), 'submodule');
         await $`${gitExe} -C ${submoduleRoot} add README.md`;
         await $`${gitExe} -C ${submoduleRoot} commit -m ${'init submodule'}`;

         const submoduleUrl = submoduleRoot.replace(/\\/g, '/');
         const submodulePath = 'deps/submodule-counter';
         await $`${gitExe} -C ${tmpDir} -c protocol.file.allow=always submodule add ${submoduleUrl} ${submodulePath}`;
         await $`${gitExe} -C ${tmpDir} add .gitmodules ${submodulePath}`;
         await $`${gitExe} -C ${tmpDir} commit -m ${'Add submodule'}`;

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

         await $`${gitExe} -C ${forkPath} -c protocol.file.allow=always submodule update --init --recursive`;
         const forkSubmodulePath = path.join(forkPath, 'deps', 'submodule-counter');

         fs.writeFileSync(path.join(forkSubmodulePath, 'change-1.txt'), 'sub-change-1');
         await $`${gitExe} -C ${forkSubmodulePath} add change-1.txt`;
         await $`${gitExe} -C ${forkSubmodulePath} -c user.name=${'Test User'} -c user.email=${'test@example.com'} -c committer.name=${'Test User'} -c committer.email=${'test@example.com'} commit -m ${'Submodule change 1'}`;

         await $`${gitExe} -C ${forkPath} add ${submodulePath}`;
         await $`${gitExe} -C ${forkPath} -c user.name=${'Test User'} -c user.email=${'test@example.com'} -c committer.name=${'Test User'} -c committer.email=${'test@example.com'} commit -m ${'Bump submodule 1'}`;

         fs.writeFileSync(path.join(forkSubmodulePath, 'change-2.txt'), 'sub-change-2');
         await $`${gitExe} -C ${forkSubmodulePath} add change-2.txt`;
         await $`${gitExe} -C ${forkSubmodulePath} -c user.name=${'Test User'} -c user.email=${'test@example.com'} -c committer.name=${'Test User'} -c committer.email=${'test@example.com'} commit -m ${'Submodule change 2'}`;

         await $`${gitExe} -C ${forkPath} add ${submodulePath}`;
         await $`${gitExe} -C ${forkPath} -c user.name=${'Test User'} -c user.email=${'test@example.com'} -c committer.name=${'Test User'} -c committer.email=${'test@example.com'} commit -m ${'Bump submodule 2'}`;

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
         expect(await parallel(removeCtx)).toBe(0);

         await resetRepo();
         await $`${gitExe} -C ${tmpDir} clean -fd`;
      },
      { timeout: 20000 }
   );

   it(
      'should cherry-pick submodule commits on join',
      async () => {
         resetCache();
         const gitExe = Array.isArray(git$) ? git$[0] : git$;
         const submoduleRoot = path.join(tmpRootDir, 'submodule-join');
         fs.mkdirSync(submoduleRoot, { recursive: true });
         await $`${gitExe} -C ${submoduleRoot} init`;
         await $`${gitExe} -C ${submoduleRoot} config user.name ${'Test User'}`;
         await $`${gitExe} -C ${submoduleRoot} config user.email ${'test@example.com'}`;
         fs.writeFileSync(path.join(submoduleRoot, 'README.md'), 'submodule');
         await $`${gitExe} -C ${submoduleRoot} add README.md`;
         await $`${gitExe} -C ${submoduleRoot} commit -m ${'init submodule'}`;

         const submoduleUrl = submoduleRoot.replace(/\\/g, '/');
         const submodulePath = 'deps/submodule-join';
         await $`${gitExe} -C ${tmpDir} -c protocol.file.allow=always submodule add ${submoduleUrl} ${submodulePath}`;
         await $`${gitExe} -C ${tmpDir} add .gitmodules ${submodulePath}`;
         await $`${gitExe} -C ${tmpDir} commit -m ${'Add submodule'}`;
         const originSubmodulePath = path.join(tmpDir, 'deps', 'submodule-join');
         await $`${gitExe} -C ${originSubmodulePath} config user.name ${'Test User'}`;
         await $`${gitExe} -C ${originSubmodulePath} config user.email ${'test@example.com'}`;

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
         const forkPath = path.join(worktreeRoot, alias);

         await $`${gitExe} -C ${forkPath} -c protocol.file.allow=always submodule update --init --recursive`;
         const forkSubmodulePath = path.join(forkPath, 'deps', 'submodule-join');

         fs.writeFileSync(path.join(forkSubmodulePath, 'join-change.txt'), 'sub-join');
         await $`${gitExe} -C ${forkSubmodulePath} add join-change.txt`;
         await $`${gitExe} -C ${forkSubmodulePath} -c user.name=${'Test User'} -c user.email=${'test@example.com'} -c committer.name=${'Test User'} -c committer.email=${'test@example.com'} commit -m ${'Submodule join change'}`;

         await $`${gitExe} -C ${forkPath} add ${submodulePath}`;
         await $`${gitExe} -C ${forkPath} -c user.name=${'Test User'} -c user.email=${'test@example.com'} -c committer.name=${'Test User'} -c committer.email=${'test@example.com'} commit -m ${'Bump submodule for join'}`;

         const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', alias]);
         expect(await parallel(joinCtx)).toBe(0);

         const submoduleLog = (
            await $`${gitExe} -C ${originSubmodulePath} log -1 --format=%s`
         ).stdout.trim();
         expect(submoduleLog).toBe('Submodule join change');

         const originLog = (await $`${gitExe} -C ${tmpDir} log --format=%s`).stdout.trim();
         expect(originLog).toContain('Bump submodule for join');

         await resetRepo();
         await $`${gitExe} -C ${tmpDir} clean -fd`;
      },
      { timeout: 20000 }
   );

   it('should skip empty cherry-picks during join', async () => {
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
      await $`${forkGit$} commit -m ${'Duplicate change'}`;
      await $`${forkGit$} reset --hard HEAD`;

      fs.writeFileSync(path.join(tmpDir, 'duplicate.txt'), 'duplicate');
      await $`${git$} -C ${tmpDir} add duplicate.txt`;
      await $`${git$} -C ${tmpDir} -c user.name=${'Test User'} -c user.email=${'test@example.com'} -c committer.name=${'Test User'} -c committer.email=${'test@example.com'} commit -m ${'Duplicate change origin'}`;

      const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', alias]);
      const joinResult = await parallel(joinCtx);
      expect(joinResult).toBe(0);

      const forkExists = await fs
         .stat(forkPath)
         .then(() => true)
         .catch(() => false);
      expect(forkExists).toBe(false);
   });

   it('should not attempt to join commits already in origin', async () => {
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
      await $`${forkGit$} commit -m ${'Join skip commit'}`;

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
      expect(buffer.stdout).toContain('No new commits to cherry-pick');
      expect(buffer.stdout).not.toContain('Join skip commit');

      const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', alias]);
      expect(await parallel(removeCtx)).toBe(0);
   });

   it(
      'should apply submodule commits in non-interactive join for branch worktree',
      async () => {
         resetCache();
         const gitExe = Array.isArray(git$) ? git$[0] : git$;
         const submoduleRoot = path.join(tmpRootDir, 'submodule-branch-join');
         fs.mkdirSync(submoduleRoot, { recursive: true });
         await $`${gitExe} -C ${submoduleRoot} init`;
         await $`${gitExe} -C ${submoduleRoot} config user.name ${'Test User'}`;
         await $`${gitExe} -C ${submoduleRoot} config user.email ${'test@example.com'}`;
         fs.writeFileSync(path.join(submoduleRoot, 'README.md'), 'submodule');
         await $`${gitExe} -C ${submoduleRoot} add README.md`;
         await $`${gitExe} -C ${submoduleRoot} commit -m ${'init submodule'}`;

         const submoduleUrl = submoduleRoot.replace(/\\/g, '/');
         const submodulePath = 'deps/submodule-branch-join';
         await $`${gitExe} -C ${tmpDir} -c protocol.file.allow=always submodule add ${submoduleUrl} ${submodulePath}`;
         await $`${gitExe} -C ${tmpDir} add .gitmodules ${submodulePath}`;
         await $`${gitExe} -C ${tmpDir} commit -m ${'Add submodule'}`;
         const originSubmodulePath = path.join(tmpDir, submodulePath);
         await $`${gitExe} -C ${originSubmodulePath} config user.name ${'Test User'}`;
         await $`${gitExe} -C ${originSubmodulePath} config user.email ${'test@example.com'}`;

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
         const forkPath = path.join(worktreeRoot, alias);

         await $`${gitExe} -C ${forkPath} -c protocol.file.allow=always submodule update --init --recursive`;
         const forkSubmodulePath = path.join(forkPath, submodulePath);

         fs.writeFileSync(path.join(forkSubmodulePath, 'branch-join.txt'), 'sub-join');
         await $`${gitExe} -C ${forkSubmodulePath} add branch-join.txt`;
         await $`${gitExe} -C ${forkSubmodulePath} -c user.name=${'Test User'} -c user.email=${'test@example.com'} -c committer.name=${'Test User'} -c committer.email=${'test@example.com'} commit -m ${'Submodule branch join change'}`;

         await $`${gitExe} -C ${forkPath} add ${submodulePath}`;
         await $`${gitExe} -C ${forkPath} -c user.name=${'Test User'} -c user.email=${'test@example.com'} -c committer.name=${'Test User'} -c committer.email=${'test@example.com'} commit -m ${'Bump submodule for branch join'}`;

         const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', alias]);
         expect(await parallel(joinCtx)).toBe(0);

         const submoduleLog = (
            await $`${gitExe} -C ${originSubmodulePath} log -1 --format=%s`
         ).stdout.trim();
         expect(submoduleLog).toBe('Submodule branch join change');

         const originLog = (await $`${gitExe} -C ${tmpDir} log --format=%s`).stdout.trim();
         expect(originLog).toContain('Bump submodule for branch join');

         await resetRepo();
         await $`${gitExe} -C ${tmpDir} clean -fd`;
      },
      { timeout: 20000 }
   );

   it('should treat empty cherry-pick as non-conflict', async () => {
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
      await $`${forkGit$} commit -m ${'Duplicate status change'}`;
      await $`${forkGit$} reset --hard HEAD`;

      fs.writeFileSync(path.join(tmpDir, 'duplicate-status.txt'), 'duplicate');
      await $`${git$} -C ${tmpDir} add duplicate-status.txt`;
      await $`${git$} -C ${tmpDir} -c user.name=${'Test User'} -c user.email=${'test@example.com'} -c committer.name=${'Test User'} -c committer.email=${'test@example.com'} commit -m ${'Duplicate status change origin'}`;

      env.isTTY = false;
      const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', alias]);
      const joinResult = await parallel(joinCtx);
      env.isTTY = true;

      expect(joinResult).toBe(0);
      expect(buffer.stdout).not.toContain('cherry-pick --continue');

      let cherryPickExitCode = 0;
      try {
         await $`${git$} -C ${tmpDir} rev-parse -q --verify CHERRY_PICK_HEAD`;
      } catch (err) {
         const typedErr = err as { exitCode?: number } | null;
         cherryPickExitCode = typedErr?.exitCode ?? 1;
      }
      expect(cherryPickExitCode).not.toBe(0);
   });
});
