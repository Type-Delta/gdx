import { afterAll, describe, expect } from 'bun:test';
import path from 'path';

import * as fs from '@/modules/fs';
import { addSubmodule } from '@/modules/git';
import { resetConfig } from '@/common/config';
import { dispatch } from '@/cli/dispatch';
import { createGdxContext, createTestEnv, setTestGitConfig } from '@/utils/testHelper';
import { resetCache } from '@/common/cache';
import { asUnixPath } from '@/utils/path';

describe('gdx submodule', async () => {
   const { tmpDir, tmpRootDir, $, buffer, it, tracker } = await createTestEnv({
      autoResetBuffer: true,
      suitName: 'submodule'
   });
   const previousGdxResult = process.env.GDX_RESULT;
   process.env.GDX_RESULT = path.join(tmpRootDir, 'gdx-result');
   const consts = await import('@/consts');
   const { default: submodule } = await import('@/commands/submodule');
   const ctx = createGdxContext(tmpDir);
   const git$ = ctx.git$;
   const gitExe = Array.isArray(git$) ? git$[0] : git$;
   afterAll(() => {
      if (previousGdxResult) {
         process.env.GDX_RESULT = previousGdxResult;
      } else {
         delete process.env.GDX_RESULT;
      }
   });

   async function withInlineAll(fn: () => Promise<void>): Promise<void> {
      const previous = process.env.GDX_USE_INLINE_SUBMODULE;
      process.env.GDX_USE_INLINE_SUBMODULE = 'all';
      resetConfig();
      try {
         await fn();
      } finally {
         if (previous === undefined) {
            delete process.env.GDX_USE_INLINE_SUBMODULE;
         } else {
            process.env.GDX_USE_INLINE_SUBMODULE = previous;
         }
         resetConfig();
      }
   }

   it('should switch to another submodule from inside a submodule', async () => {
      if (!gitExe) throw new Error('Git not found');

      const submoduleRoot = path.join(tmpRootDir, 'submodule-switch');
      const otherSubmoduleRoot = path.join(tmpRootDir, 'submodule-switch-other');
      fs.mkdirSync(submoduleRoot, { recursive: true });
      fs.mkdirSync(otherSubmoduleRoot, { recursive: true });

      await $`${gitExe} -C ${submoduleRoot} init`;
      await setTestGitConfig(submoduleRoot, 'user.name', 'Test User');
      await setTestGitConfig(submoduleRoot, 'user.email', 'test@example.com');
      await $`${gitExe} -C ${submoduleRoot} commit --no-verify --allow-empty -m ${'init submodule one'}`;

      await $`${gitExe} -C ${otherSubmoduleRoot} init`;
      await setTestGitConfig(otherSubmoduleRoot, 'user.name', 'Test User');
      await setTestGitConfig(otherSubmoduleRoot, 'user.email', 'test@example.com');
      await $`${gitExe} -C ${otherSubmoduleRoot} commit --no-verify --allow-empty -m ${'init submodule two'}`;

      const submoduleUrl = asUnixPath(submoduleRoot);
      const otherSubmoduleUrl = asUnixPath(otherSubmoduleRoot);
      await addSubmodule(git$, tmpDir, submoduleUrl, 'deps/submodule-one');
      await addSubmodule(git$, tmpDir, otherSubmoduleUrl, 'deps/submodule-two');
      await $`${gitExe} -C ${tmpDir} add .gitmodules ${'deps/submodule-one'} ${'deps/submodule-two'}`;
      await $`${gitExe} -C ${tmpDir} commit --no-verify -m ${'Add submodules'}`;

      resetCache();
      buffer.stdout = '';
      buffer.stderr = '';
      tracker.scheduledDirs.length = 0;

      if (!consts.GDX_RESULT_FILE) {
         const failCtx = createGdxContext(path.join(tmpDir, 'deps', 'submodule-one'), [
            'submodule',
            'switch',
            'submodule-two',
         ]);
         expect(await submodule.switch(failCtx)).toBe(1);
         expect(buffer.stderr).toContain('requires the shell integration');
         return;
      }

      const switchCtx = createGdxContext(path.join(tmpDir, 'deps', 'submodule-one'), [
         'submodule',
         'switch',
         'submodule-two',
      ]);
      expect(await submodule.switch(switchCtx)).toBe(0);

      const scheduled = tracker.scheduledDirs.map((value) => asUnixPath(value));
      expect(scheduled).toEqual([asUnixPath(path.join(tmpDir, 'deps', 'submodule-two'))]);
   });

   it('should switch to main from inside a submodule', async () => {
      if (!consts.GDX_RESULT_FILE) {
         return;
      }

      resetCache();
      buffer.stdout = '';
      buffer.stderr = '';
      tracker.scheduledDirs.length = 0;

      const ctx = createGdxContext(path.join(tmpDir, 'deps', 'submodule-two'), [
         'submodule',
         'switch',
         'main',
      ]);
      expect(await submodule.switch(ctx)).toBe(0);

      const scheduled = tracker.scheduledDirs.map((value) => asUnixPath(value));
      expect(scheduled).toEqual([asUnixPath(tmpDir)]);
   });

   it('should route `gdx submodule add` to inline mode when useInlineSubmodule=all', async () => {
      await withInlineAll(async () => {
         const sourceRoot = path.join(tmpRootDir, 'submodule-inline-add-source');
         fs.mkdirSync(sourceRoot, { recursive: true });
         await $`${gitExe} -C ${sourceRoot} init`;
         await setTestGitConfig(sourceRoot, 'user.name', 'Test User');
         await setTestGitConfig(sourceRoot, 'user.email', 'test@example.com');
         await $`${gitExe} -C ${sourceRoot} commit --no-verify --allow-empty -m ${'init inline add source'}`;

         const sourceUrl = asUnixPath(sourceRoot);
         const addCtx = createGdxContext(tmpDir, [
            'submodule',
            'add',
            '--name',
            'inline-dep',
            '--branch',
            'master',
            sourceUrl,
            'deps/inline-one',
         ]);

         expect(await dispatch(addCtx)).toBe(0);

         const gitmodules = fs.readFileSync(path.join(tmpDir, '.gitmodules'), 'utf-8');
         expect(gitmodules).toContain('[submodule "inline-dep"]');
         expect(gitmodules).toContain('path = deps/inline-one');
         expect(gitmodules).toContain(`url = ${sourceUrl}`);
         expect(gitmodules).toContain('branch = master');
         expect(buffer.stdout).toContain('Submodule add:');
      });
   });

   it('should suppress inline submodule info when --quiet is passed', async () => {
      await withInlineAll(async () => {
         const sourceRoot = path.join(tmpRootDir, 'submodule-inline-verbose-source');
         fs.mkdirSync(sourceRoot, { recursive: true });
         await $`${gitExe} -C ${sourceRoot} init`;
         await setTestGitConfig(sourceRoot, 'user.name', 'Test User');
         await setTestGitConfig(sourceRoot, 'user.email', 'test@example.com');
         await $`${gitExe} -C ${sourceRoot} commit --no-verify --allow-empty -m ${'init inline verbose source'}`;

         const sourceUrl = asUnixPath(sourceRoot);
         const addCtx = createGdxContext(tmpDir, [
            '-c',
            'protocol.file.allow=always',
            'submodule',
            '--quiet',
            'add',
            sourceUrl,
            'deps/inline-verbose',
         ]);

         expect(await dispatch(addCtx)).toBe(0);
         expect(buffer.stdout).not.toContain('Submodule add: path=deps/inline-verbose');
      });
   });

   it('should route `gdx submodule update` to inline mode when useInlineSubmodule=all', async () => {
      await withInlineAll(async () => {
         const sourceRoot = path.join(tmpRootDir, 'submodule-inline-update-source');
         fs.mkdirSync(sourceRoot, { recursive: true });
         await $`${gitExe} -C ${sourceRoot} init`;
         await setTestGitConfig(sourceRoot, 'user.name', 'Test User');
         await setTestGitConfig(sourceRoot, 'user.email', 'test@example.com');
         await $`${gitExe} -C ${sourceRoot} commit --no-verify --allow-empty -m ${'init inline update source'}`;

         const sourceUrl = asUnixPath(sourceRoot);
         await addSubmodule(git$, tmpDir, sourceUrl, 'deps/inline-update');
         await $`${gitExe} -C ${tmpDir} add .gitmodules ${'deps/inline-update'}`;
         await $`${gitExe} -C ${tmpDir} commit --no-verify -m ${'add inline update submodule'}`;

         fs.writeFileSync(path.join(sourceRoot, 'SECOND.md'), 'second');
         await $`${gitExe} -C ${sourceRoot} add SECOND.md`;
         await $`${gitExe} -C ${sourceRoot} commit --no-verify -m ${'second source commit'}`;
         const sourceHead = (await $`${gitExe} -C ${sourceRoot} rev-parse HEAD`).stdout.trim();

         await $`${gitExe} -C ${tmpDir} update-index --cacheinfo ${'160000'} ${sourceHead} ${'deps/inline-update'}`;

         const updateCtx = createGdxContext(tmpDir, [
            'submodule',
            'update',
            '--init',
            '--recursive',
            'deps/inline-update',
         ]);

         expect(await dispatch(updateCtx)).toBe(0);
         expect(buffer.stdout).toContain('Submodule update:');

         const submoduleHead = (
            await $`${gitExe} -C ${path.join(tmpDir, 'deps', 'inline-update')} rev-parse HEAD`
         ).stdout.trim();
         expect(submoduleHead).toBe(sourceHead);
      });
   });

   it('should route `gdx submodule deinit` to inline mode when useInlineSubmodule=all', async () => {
      await withInlineAll(async () => {
         const sourceRoot = path.join(tmpRootDir, 'submodule-inline-deinit-source');
         fs.mkdirSync(sourceRoot, { recursive: true });
         await $`${gitExe} -C ${sourceRoot} init`;
         await setTestGitConfig(sourceRoot, 'user.name', 'Test User');
         await setTestGitConfig(sourceRoot, 'user.email', 'test@example.com');
         await $`${gitExe} -C ${sourceRoot} commit --no-verify --allow-empty -m ${'init inline deinit source'}`;

         const sourceUrl = asUnixPath(sourceRoot);
         await addSubmodule(git$, tmpDir, sourceUrl, 'deps/inline-deinit');
         await $`${gitExe} -C ${tmpDir} add .gitmodules ${'deps/inline-deinit'}`;
         await $`${gitExe} -C ${tmpDir} commit --no-verify -m ${'add inline deinit submodule'}`;

         const deinitCtx = createGdxContext(tmpDir, [
            'submodule',
            'deinit',
            '-f',
            'deps/inline-deinit',
         ]);

         expect(await dispatch(deinitCtx)).toBe(0);
         expect(buffer.stdout).toContain('Submodule deinit:');

         const gitMarkerExists = fs.existsSync(path.join(tmpDir, 'deps', 'inline-deinit', '.git'));
         expect(gitMarkerExists).toBe(false);
      });
   });
});
