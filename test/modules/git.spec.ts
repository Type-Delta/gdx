import { describe, expect } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';

import {
   addSubmodule,
   deinitSubmodules,
   getGitConfigRegexp,
   getGitConfigValue,
   unsetGitConfigValue,
   getMainWorktreeRoot,
   updateSubmodules,
   isEmptyCherryPickError,
   removeGitConfigSection,
   revParseCached,
   resolveRefShaCached,
   hasCherryPickInProgress,
   setGitConfigValue,
} from '@/modules/git';
import { getConfig, resetConfig } from '@/common/config';
import { createTestEnv, createGdxContext, setTestGitConfig } from '@/utils/testHelper';
import { asUnixPath } from '@/utils/path';

describe('git module', async () => {
   const { tmpDir, tmpRootDir, $, it } = await createTestEnv({ suitName: 'git' });

   async function withInlineSubmoduleMode(
      mode: 'off' | 'internal' | 'all',
      fn: () => Promise<void>
   ): Promise<void> {
      const previous = process.env.GDX_USE_INLINE_SUBMODULE;
      process.env.GDX_USE_INLINE_SUBMODULE = mode;
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

   async function withInlineGitConfigMode(
      mode: 'off' | 'internal',
      fn: () => Promise<void>
   ): Promise<void> {
      const previous = process.env.GDX_USE_INLINE_GIT_CONFIG;
      process.env.GDX_USE_INLINE_GIT_CONFIG = mode;
      resetConfig();
      try {
         await fn();
      } finally {
         if (previous === undefined) {
            delete process.env.GDX_USE_INLINE_GIT_CONFIG;
         } else {
            process.env.GDX_USE_INLINE_GIT_CONFIG = previous;
         }
         resetConfig();
      }
   }

   async function createParityRepos(suffix: string): Promise<{
      git$: string | string[];
      gitExe: string;
      sourceRepo: string;
      internalRepo: string;
      nativeRepo: string;
      submodulePath: string;
   }> {
      const { git$ } = createGdxContext(tmpDir, []);
      const gitExe = Array.isArray(git$) ? git$[0] : git$;
      const submodulePath = 'deps/compare';
      const sourceRepo = path.join(tmpRootDir, `submodule-compare-${suffix}-source`);
      const internalRepo = path.join(tmpRootDir, `submodule-compare-${suffix}-internal`);
      const nativeRepo = path.join(tmpRootDir, `submodule-compare-${suffix}-native`);

      await fs.mkdir(sourceRepo, { recursive: true });
      await $`${gitExe} -C ${sourceRepo} init`;
      await setTestGitConfig(sourceRepo, 'user.name', 'Test User');
      await setTestGitConfig(sourceRepo, 'user.email', 'test@example.com');
      await fs.writeFile(path.join(sourceRepo, 'README.md'), 'source');
      await $`${gitExe} -C ${sourceRepo} add README.md`;
      await $`${gitExe} -C ${sourceRepo} commit -m ${'init source repo'}`;

      for (const repoPath of [internalRepo, nativeRepo]) {
         await fs.mkdir(repoPath, { recursive: true });
         await $`${gitExe} -C ${repoPath} init`;
         await setTestGitConfig(repoPath, 'user.name', 'Test User');
         await setTestGitConfig(repoPath, 'user.email', 'test@example.com');
         await fs.writeFile(path.join(repoPath, 'ROOT.md'), 'root');
         await $`${gitExe} -C ${repoPath} add ROOT.md`;
         await $`${gitExe} -C ${repoPath} commit -m ${'init root repo'}`;
      }

      return {
         git$,
         gitExe,
         sourceRepo,
         internalRepo,
         nativeRepo,
         submodulePath,
      };
   }

   it('should resolve main worktree root from .git file worktree', async () => {
      const worktreeDir = path.join(tmpRootDir, 'wt-case');
      await $`git worktree add ${worktreeDir} -b ${'worktree-test'}`;

      const gitFilePath = path.join(worktreeDir, '.git');
      const gitFileContent = await fs.readFile(gitFilePath, 'utf-8');
      expect(gitFileContent.toLowerCase()).toContain('gitdir:');

      const wtCtx = createGdxContext(worktreeDir, []);
      const mainRoot = await getMainWorktreeRoot(wtCtx.git$);

      expect(asUnixPath(mainRoot)).toBe(asUnixPath(tmpDir));
   });

   it('should deinit submodules for a worktree', async () => {
      const { git$ } = createGdxContext(tmpDir, []);
      const gitExe = Array.isArray(git$) ? git$[0] : git$;
      const submoduleRoot = path.join(tmpRootDir, 'submodule-clean');
      await fs.mkdir(submoduleRoot, { recursive: true });
      await $`${gitExe} -C ${submoduleRoot} init`;
      await setTestGitConfig(submoduleRoot, 'user.name', 'Test User');
      await setTestGitConfig(submoduleRoot, 'user.email', 'test@example.com');
      await fs.writeFile(path.join(submoduleRoot, 'README.md'), 'submodule');
      await $`${gitExe} -C ${submoduleRoot} add README.md`;
      await $`${gitExe} -C ${submoduleRoot} commit -m ${'init submodule'}`;

      const submoduleUrl = asUnixPath(submoduleRoot);
      await addSubmodule(git$, tmpDir, submoduleUrl, 'deps/submodule');
      await $`${gitExe} -C ${tmpDir} add .gitmodules ${'deps/submodule'}`;
      await $`${gitExe} -C ${tmpDir} commit -m ${'Add submodule'}`;

      const submodulePath = path.join(tmpDir, 'deps', 'submodule');
      const gitMarker = path.join(submodulePath, '.git');
      const beforeExists = await fs
         .stat(gitMarker)
         .then(() => true)
         .catch(() => false);
      expect(beforeExists).toBe(true);

      await deinitSubmodules(git$, tmpDir);

      const afterExists = await fs
         .stat(gitMarker)
         .then(() => true)
         .catch(() => false);
      expect(afterExists).toBe(false);

      const statusOutput = (await $`${gitExe} -C ${tmpDir} submodule status`).stdout.trim();
      expect(statusOutput.startsWith('-')).toBe(true);

      const entries = await fs.readdir(submodulePath);
      expect(entries.length).toBe(0);
   }, { timeout: 15000 });

   it('should honor useInlineSubmodule=off for add/update/deinit', async () => {
      const config = await getConfig();
      await config.set('useInlineSubmodule', 'off');
      await config.save();
      resetConfig();

      try {
         const { git$ } = createGdxContext(tmpDir, []);
         const gitExe = Array.isArray(git$) ? git$[0] : git$;
         const submoduleRoot = path.join(tmpRootDir, 'submodule-off-mode');
         await fs.mkdir(submoduleRoot, { recursive: true });
         await $`${gitExe} -C ${submoduleRoot} init`;
         await setTestGitConfig(submoduleRoot, 'user.name', 'Test User');
         await setTestGitConfig(submoduleRoot, 'user.email', 'test@example.com');
         await $`${gitExe} -C ${submoduleRoot} commit --no-verify --allow-empty -m ${'init submodule off mode'}`;

         const submoduleUrl = asUnixPath(submoduleRoot);
         await addSubmodule(git$, tmpDir, submoduleUrl, 'deps/submodule-off');
         await $`${gitExe} -C ${tmpDir} add .gitmodules ${'deps/submodule-off'}`;
         await $`${gitExe} -C ${tmpDir} commit --no-verify -m ${'Add submodule off mode'}`;

         await deinitSubmodules(git$, tmpDir);

         const statusOutput = (await $`${gitExe} -C ${tmpDir} submodule status`).stdout.trim();
         expect(statusOutput.startsWith('-')).toBe(true);
      } finally {
         const restoredConfig = await getConfig();
         await restoredConfig.set('useInlineSubmodule', 'internal');
         await restoredConfig.save();
         resetConfig();
      }
   });

   it('should detect empty cherry-pick errors from output text', async () => {
      const err = {
         stderr: 'The previous cherry-pick is now empty, possibly due to conflict resolution.',
      };
      expect(isEmptyCherryPickError(err)).toBe(true);
   });

   it('should read git config via internal file parser', async () => {
      const { git$ } = createGdxContext(tmpDir, []);

      await withInlineGitConfigMode('internal', async () => {
         await setGitConfigValue(git$, 'test.inline', 'local-inline-value', { repoPath: tmpDir });
         const value = await getGitConfigValue(git$, 'test.inline', tmpDir);
         expect(value).toBe('local-inline-value');
      });
   });

   it('should read .gitmodules entries via internal config regexp', async () => {
      const { git$ } = createGdxContext(tmpDir, []);
      const gitmodulesPath = path.join(tmpDir, '.gitmodules');
      await fs.writeFile(
         gitmodulesPath,
         '[submodule "pkg.with.dot"]\n\tpath = deps/dotted\n\turl = ../example.git\n'
      );

      await withInlineGitConfigMode('internal', async () => {
         const entries = await getGitConfigRegexp(git$, '^submodule\\..*\\.path$', {
            repoPath: tmpDir,
            filePath: '.gitmodules',
         });
         expect(entries.some((entry) => entry.key === 'submodule.pkg.with.dot.path')).toBe(true);
         expect(entries.some((entry) => entry.value === 'deps/dotted')).toBe(true);
      });
   });

   it('should remove local config section via internal writer', async () => {
      const { git$ } = createGdxContext(tmpDir, []);

      await withInlineGitConfigMode('internal', async () => {
         await setGitConfigValue(git$, 'submodule.removable.path', 'deps/removable', {
            repoPath: tmpDir,
         });
         await removeGitConfigSection(git$, tmpDir, 'submodule.removable');

         const value = await getGitConfigValue(git$, 'submodule.removable.path', tmpDir);
         expect(value).toBe('');
      });
   });

   it('should fallback to git executable when inline git config mode is off', async () => {
      const { git$ } = createGdxContext(tmpDir, []);

      await withInlineGitConfigMode('off', async () => {
         const value = await getGitConfigValue(git$, 'user.email', tmpDir);
         expect(value).toBe('test@example.com');
      });
   });

   it('should set and unset git config via inline writer', async () => {
      const { git$ } = createGdxContext(tmpDir, []);

      await withInlineGitConfigMode('internal', async () => {
         await setGitConfigValue(git$, 'test.inline.writer', 'writer-value', { repoPath: tmpDir });
         expect(await getGitConfigValue(git$, 'test.inline.writer', tmpDir)).toBe('writer-value');

         await unsetGitConfigValue(git$, 'test.inline.writer', { repoPath: tmpDir });
         expect(await getGitConfigValue(git$, 'test.inline.writer', tmpDir)).toBe('');
      });
   });

   it('should resolve rev-parse through wrapper with -C scope', async () => {
      const { git$ } = createGdxContext(tmpDir, []);
      const branch = (await revParseCached(git$, '--abbrev-ref HEAD')).trim();
      expect(branch).toBe('master');

      const gitExe = Array.isArray(git$) ? git$[0] : git$;
      const scoped = [gitExe, '-C', tmpDir];
      const headFromScoped = (await revParseCached(scoped, 'HEAD')).trim();
      const headFromDirect = (await revParseCached(git$, 'HEAD', tmpDir)).trim();
      expect(headFromScoped).toBe(headFromDirect);
   });

   it('should invalidate cached head scope when HEAD advances', async () => {
      const { git$ } = createGdxContext(tmpDir, []);

      const before = (await revParseCached(git$, 'HEAD')).trim();
      await $`git commit --allow-empty -m ${'advance head for rev-parse cache'}`;
      const after = (await revParseCached(git$, 'HEAD')).trim();

      expect(after).toBeTruthy();
      expect(after).not.toBe(before);
   });

   it('should invalidate cached refs scope when branch ref changes', async () => {
      const { git$ } = createGdxContext(tmpDir, []);

      await $`git branch ${'cache-ref-target'}`;
      const first = (await revParseCached(git$, 'cache-ref-target')).trim();
      await $`git commit --allow-empty -m ${'move branch for rev-parse cache'}`;
      const latestHead = (await revParseCached(git$, 'HEAD')).trim();
      await $`git update-ref ${'refs/heads/cache-ref-target'} ${latestHead}`;

      const second = (await revParseCached(git$, 'cache-ref-target')).trim();
      expect(second).toBe(latestHead);
      expect(second).not.toBe(first);
   });

   it('should resolve refs to sha using verify wrapper with optional type', async () => {
      const { git$ } = createGdxContext(tmpDir, []);

      const headCommit = await resolveRefShaCached(git$, 'HEAD', { type: 'commit' });
      const headRaw = await resolveRefShaCached(git$, 'HEAD');
      expect(headCommit).toBeTruthy();
      expect(headRaw).toBe(headCommit);

      await $`git tag -a v-test -m ${'annotated test tag'}`;
      const tagObject = await resolveRefShaCached(git$, 'refs/tags/v-test', { type: 'tag' });
      expect(tagObject).toBeTruthy();

      const invalid = await resolveRefShaCached(git$, 'refs/tags/does-not-exist');
      expect(invalid).toBeNull();
   });

   it('should detect cherry-pick in progress via git-path check', async () => {
      const { git$ } = createGdxContext(tmpDir, []);
      const gitExe = Array.isArray(git$) ? git$[0] : git$;
      const forkPath = path.join(tmpRootDir, 'cherry-pick-check');

      await $`${gitExe} -C ${tmpDir} commit --allow-empty -m ${'base for cherry-pick check'}`;
      await $`${gitExe} -C ${tmpDir} worktree add ${forkPath} -b ${'cherry-pick-check'}`;

      try {
         await fs.writeFile(path.join(tmpDir, 'conflict-check.txt'), 'origin\n');
         await $`${gitExe} -C ${tmpDir} add conflict-check.txt`;
         await $`${gitExe} -C ${tmpDir} commit -m ${'origin change for cherry-pick check'}`;

         await fs.writeFile(path.join(forkPath, 'conflict-check.txt'), 'fork\n');
         await $`${gitExe} -C ${forkPath} add conflict-check.txt`;
         await $`${gitExe} -C ${forkPath} commit -m ${'fork change for cherry-pick check'}`;

         const forkHead = (await $`${gitExe} -C ${forkPath} rev-parse HEAD`).stdout.trim();
         let cherryPickFailed = false;
         try {
            await $`${gitExe} -C ${tmpDir} cherry-pick ${forkHead}`;
         } catch {
            cherryPickFailed = true;
         }
         expect(cherryPickFailed).toBe(true);

         expect(await hasCherryPickInProgress(git$, tmpDir)).toBe(true);

         await $`${gitExe} -C ${tmpDir} cherry-pick --abort`;
         expect(await hasCherryPickInProgress(git$, tmpDir)).toBe(false);
      } finally {
         await $`${gitExe} worktree remove --force ${forkPath}`;
      }
   });

   it('should detect empty cherry-pick errors with ANSI output', async () => {
      const err = {
         stderr: '\u001b[31mThe previous cherry-pick is now empty\u001b[0m',
      };
      expect(isEmptyCherryPickError(err)).toBe(true);
   });

   it('should not treat conflict guidance as empty cherry-pick', async () => {
      const err = {
         stderr: 'After resolving the conflicts, mark the corrected paths with git add',
      };
      expect(isEmptyCherryPickError(err)).toBe(false);
   });

   it(
      'should align internal and git-native behavior for addSubmodule',
      async () => {
         const { git$, gitExe, sourceRepo, internalRepo, nativeRepo, submodulePath } =
            await createParityRepos('add');
         const sourceUrl = asUnixPath(sourceRepo);

         await withInlineSubmoduleMode('internal', async () => {
            await addSubmodule(git$, internalRepo, sourceUrl, submodulePath, {
               allowFileProtocol: true,
            });
         });
         await withInlineSubmoduleMode('off', async () => {
            await addSubmodule(git$, nativeRepo, sourceUrl, submodulePath, {
               allowFileProtocol: true,
            });
         });

         const internalGitmodules = await fs.readFile(
            path.join(internalRepo, '.gitmodules'),
            'utf-8'
         );
         const nativeGitmodules = await fs.readFile(path.join(nativeRepo, '.gitmodules'), 'utf-8');
         expect(internalGitmodules).toBe(nativeGitmodules);

         const internalGitlink = (
            await $`${gitExe} -C ${internalRepo} ls-files --stage -- ${submodulePath}`
         ).stdout.trim();
         const nativeGitlink = (
            await $`${gitExe} -C ${nativeRepo} ls-files --stage -- ${submodulePath}`
         ).stdout.trim();
         expect(internalGitlink).toBe(nativeGitlink);
      },
      { timeout: 30000 }
   );

   it(
      'should align internal and git-native behavior for updateSubmodules',
      async () => {
         const { git$, gitExe, sourceRepo, internalRepo, nativeRepo, submodulePath } =
            await createParityRepos('update');
         const sourceUrl = asUnixPath(sourceRepo);

         await withInlineSubmoduleMode('internal', async () => {
            await addSubmodule(git$, internalRepo, sourceUrl, submodulePath, {
               allowFileProtocol: true,
            });
         });
         await withInlineSubmoduleMode('off', async () => {
            await addSubmodule(git$, nativeRepo, sourceUrl, submodulePath, {
               allowFileProtocol: true,
            });
         });

         await $`${gitExe} -C ${internalRepo} add .gitmodules ${submodulePath}`;
         await $`${gitExe} -C ${internalRepo} commit -m ${'add compare submodule internal'}`;
         await $`${gitExe} -C ${nativeRepo} add .gitmodules ${submodulePath}`;
         await $`${gitExe} -C ${nativeRepo} commit -m ${'add compare submodule native'}`;

         await fs.writeFile(path.join(sourceRepo, 'SECOND.md'), 'second');
         await $`${gitExe} -C ${sourceRepo} add SECOND.md`;
         await $`${gitExe} -C ${sourceRepo} commit -m ${'second source commit'}`;
         const sourceHead = (await $`${gitExe} -C ${sourceRepo} rev-parse HEAD`).stdout.trim();

         await $`${gitExe} -C ${internalRepo} update-index --cacheinfo ${'160000'} ${sourceHead} ${submodulePath}`;
         await $`${gitExe} -C ${nativeRepo} update-index --cacheinfo ${'160000'} ${sourceHead} ${submodulePath}`;

         await withInlineSubmoduleMode('internal', async () => {
            await updateSubmodules(git$, internalRepo, {
               recursive: true,
               allowFileProtocol: true,
            });
         });
         await withInlineSubmoduleMode('off', async () => {
            await updateSubmodules(git$, nativeRepo, {
               recursive: true,
               allowFileProtocol: true,
            });
         });

         const internalHead = (
            await $`${gitExe} -C ${path.join(internalRepo, submodulePath)} rev-parse HEAD`
         ).stdout.trim();
         const nativeHead = (
            await $`${gitExe} -C ${path.join(nativeRepo, submodulePath)} rev-parse HEAD`
         ).stdout.trim();
         expect(internalHead).toBe(sourceHead);
         expect(nativeHead).toBe(sourceHead);
      },
      { timeout: 30000 }
   );

   it(
      'should align internal and git-native behavior for deinitSubmodules',
      async () => {
         const { git$, gitExe, sourceRepo, internalRepo, nativeRepo, submodulePath } =
            await createParityRepos('deinit');
         const sourceUrl = asUnixPath(sourceRepo);

         await withInlineSubmoduleMode('internal', async () => {
            await addSubmodule(git$, internalRepo, sourceUrl, submodulePath, {
               allowFileProtocol: true,
            });
         });
         await withInlineSubmoduleMode('off', async () => {
            await addSubmodule(git$, nativeRepo, sourceUrl, submodulePath, {
               allowFileProtocol: true,
            });
         });

         await $`${gitExe} -C ${internalRepo} add .gitmodules ${submodulePath}`;
         await $`${gitExe} -C ${internalRepo} commit -m ${'add compare submodule internal'}`;
         await $`${gitExe} -C ${nativeRepo} add .gitmodules ${submodulePath}`;
         await $`${gitExe} -C ${nativeRepo} commit -m ${'add compare submodule native'}`;

         await withInlineSubmoduleMode('internal', async () => {
            await deinitSubmodules(git$, internalRepo);
         });
         await withInlineSubmoduleMode('off', async () => {
            await deinitSubmodules(git$, nativeRepo);
         });

         const internalStatus = (
            await $`${gitExe} -C ${internalRepo} submodule status`
         ).stdout.trim();
         const nativeStatus = (await $`${gitExe} -C ${nativeRepo} submodule status`).stdout.trim();
         expect(internalStatus.startsWith('-')).toBe(true);
         expect(nativeStatus.startsWith('-')).toBe(true);

         const internalMarkerExists = await fs
            .stat(path.join(internalRepo, submodulePath, '.git'))
            .then(() => true)
            .catch(() => false);
         const nativeMarkerExists = await fs
            .stat(path.join(nativeRepo, submodulePath, '.git'))
            .then(() => true)
            .catch(() => false);
         expect(internalMarkerExists).toBe(false);
         expect(nativeMarkerExists).toBe(false);
      },
      { timeout: 30000 }
   );
});
