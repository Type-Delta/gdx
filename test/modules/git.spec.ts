import { describe, expect } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';

import {
   addSubmodule,
   deinitSubmodules,
   getGitAuthorExistsCached,
   getGitBranchesCached,
   getGitConfigCached,
   getGitConfigRegexp,
   getGitConfigValue,
   getGitPath,
   getGitTagsCached,
   getRepoRootCached,
   getSubmoduleBaseSha,
   getSubmodules,
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
import { getCache, resetCache as resetCacheService } from '@/common/cache';
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

   it('should discover a repository initialized after cached discovery failures', async () => {
      const { git$ } = createGdxContext(tmpDir, []);
      const gitExe = Array.isArray(git$) ? git$[0] : git$;
      const repoPath = path.join(tmpRootDir, 'late-init-repo');
      const scopedGit = [gitExe, '-C', repoPath];
      await fs.mkdir(repoPath, { recursive: true });

      expect(await revParseCached(scopedGit, '--is-inside-work-tree')).toBe('');
      let rootLookupFailed = false;
      try {
         await getRepoRootCached(scopedGit, true);
      } catch {
         rootLookupFailed = true;
      }
      expect(rootLookupFailed).toBe(true);
      expect(await getGitPath(gitExe, repoPath, 'config')).toBeNull();

      await $`${gitExe} -C ${repoPath} init`;

      expect(await revParseCached(scopedGit, '--is-inside-work-tree')).toBe('true');
      expect(asUnixPath(await getRepoRootCached(scopedGit, true))).toBe(asUnixPath(repoPath));
      expect(asUnixPath((await getGitPath(gitExe, repoPath, 'config'))!)).toBe(
         asUnixPath(path.join(repoPath, '.git', 'config'))
      );
   });

   it('should discover an ancestor repository initialized after nested failures', async () => {
      const { git$ } = createGdxContext(tmpDir, []);
      const gitExe = Array.isArray(git$) ? git$[0] : git$;
      const ancestorPath = path.join(tmpRootDir, 'nested-ancestor-repo');
      const nestedPath = path.join(ancestorPath, 'nested');
      const scopedGit = [gitExe, '-C', nestedPath];
      await fs.mkdir(nestedPath, { recursive: true });

      expect(await revParseCached(scopedGit, '--is-inside-work-tree')).toBe('');
      expect(await getGitPath(gitExe, nestedPath, 'config')).toBeNull();

      await $`${gitExe} -C ${ancestorPath} init`;

      expect(await revParseCached(scopedGit, '--is-inside-work-tree')).toBe('true');
      expect(asUnixPath((await getGitPath(gitExe, nestedPath, 'config'))!)).toBe(
         asUnixPath(path.join(ancestorPath, '.git', 'config'))
      );
   });

   it('should not persist empty rev-parse results before repository restoration', async () => {
      const { git$ } = createGdxContext(tmpDir, []);
      const gitExe = Array.isArray(git$) ? git$[0] : git$;
      const repoPath = path.join(tmpRootDir, 'empty-rev-parse-cache');
      const scopedGit = [gitExe, '-C', repoPath];
      await fs.mkdir(repoPath, { recursive: true });

      expect(await revParseCached(scopedGit, '--is-inside-work-tree')).toBe('');

      await $`${gitExe} -C ${repoPath} init`;
      await setTestGitConfig(repoPath, 'user.name', 'Test User');
      await setTestGitConfig(repoPath, 'user.email', 'test@example.com');
      await $`${gitExe} -C ${repoPath} commit --allow-empty -m ${'empty rev-parse cache base'}`;

      const cache = await getCache();
      const beforeInvalidRef = new Set(Object.keys((await cache.getAll()).entryMeta));
      expect(await revParseCached(scopedGit, ['--verify', 'restored-ref'])).toBe('');

      const afterInvalidRef = Object.keys((await cache.getAll()).entryMeta).filter(
         (key) => key.includes('.revParse.') && !beforeInvalidRef.has(key)
      );
      expect(afterInvalidRef).toEqual([]);

      expect(await revParseCached(scopedGit, '--show-superproject-working-tree')).toBe('');
      await $`${gitExe} -C ${repoPath} branch ${'restored-ref'}`;

      const restoredRef = (await revParseCached(scopedGit, ['--verify', 'restored-ref'])).trim();
      expect(restoredRef).toBeTruthy();
   });

   it('should bypass legacy rev-parse cache values', async () => {
      const { git$ } = createGdxContext(tmpDir, []);
      const gitExe = Array.isArray(git$) ? git$[0] : git$;
      const repoPath = path.join(tmpRootDir, 'legacy-rev-parse-cache');
      const scopedGit = [gitExe, '-C', repoPath];
      await fs.mkdir(repoPath, { recursive: true });
      await $`${gitExe} -C ${repoPath} init`;
      await setTestGitConfig(repoPath, 'user.name', 'Test User');
      await setTestGitConfig(repoPath, 'user.email', 'test@example.com');
      await $`${gitExe} -C ${repoPath} commit --allow-empty -m ${'legacy rev-parse cache base'}`;
      await $`${gitExe} -C ${repoPath} branch ${'legacy-ref'}`;

      const cache = await getCache();
      const cacheKeysBeforeLookup = new Set(Object.keys((await cache.getAll()).entryMeta));
      const expected = (await revParseCached(scopedGit, ['--verify', 'refs/heads/legacy-ref'])).trim();
      const cacheKey = Object.keys((await cache.getAll()).entryMeta).find(
         (key) => key.includes('.revParse.') && !cacheKeysBeforeLookup.has(key)
      );
      expect(cacheKey).toBeTruthy();

      for (const legacyValue of ['', null, { invalid: true }]) {
         await cache.set(cacheKey!, legacyValue);
         expect(
            (await revParseCached(scopedGit, ['--verify', 'refs/heads/legacy-ref'])).trim()
         ).toBe(expected);
      }
   });

   it('should retry submodule config discovery after a transient read error', async () => {
      const { git$ } = createGdxContext(tmpDir, []);
      const gitExe = Array.isArray(git$) ? git$[0] : git$;
      const repoPath = path.join(tmpRootDir, 'transient-submodule-discovery');
      const gitmodulesPath = path.join(repoPath, '.gitmodules');
      await fs.mkdir(repoPath, { recursive: true });
      await $`${gitExe} -C ${repoPath} init`;

      await withInlineGitConfigMode('off', async () => {
         await fs.writeFile(gitmodulesPath, '[submodule "late"\n\tpath = deps/late\n');
         const fixedMtime = 1_700_000_000;
         await fs.utimes(gitmodulesPath, fixedMtime, fixedMtime);
         expect(await getSubmodules(git$, repoPath)).toEqual([]);

         await fs.writeFile(
            gitmodulesPath,
            '[submodule "late"]\n\tpath = deps/late\n\turl = ../late.git\n'
         );
         await fs.utimes(gitmodulesPath, fixedMtime, fixedMtime);

         expect(await getSubmodules(git$, repoPath)).toEqual([
            { path: 'deps/late', status: '-', initialized: false },
         ]);
      });
   });

   it('should throw for missing config files when requested', async () => {
      const { git$ } = createGdxContext(tmpDir, []);
      const gitExe = Array.isArray(git$) ? git$[0] : git$;
      const repoPath = path.join(tmpRootDir, 'missing-config-read');
      await fs.mkdir(repoPath, { recursive: true });
      await $`${gitExe} -C ${repoPath} init`;

      await withInlineGitConfigMode('internal', async () => {
         expect(
            await getGitConfigRegexp(git$, 'path', {
               repoPath,
               filePath: '.gitmodules',
            })
         ).toEqual([]);
         await expect(
            getGitConfigRegexp(git$, 'path', {
               repoPath,
               filePath: '.gitmodules',
               throwOnError: true,
            })
         ).rejects.toThrow();
      });
   });

   it('should preserve cached gitlink metadata across submodule status reads', async () => {
      const { git$ } = createGdxContext(tmpDir, []);
      const gitExe = Array.isArray(git$) ? git$[0] : git$;
      const sourceRepo = path.join(tmpRootDir, 'cached-gitlink-source');
      const parentRepo = path.join(tmpRootDir, 'cached-gitlink-parent');
      const submodulePath = 'deps/late';
      await fs.mkdir(sourceRepo, { recursive: true });
      await fs.mkdir(parentRepo, { recursive: true });
      await $`${gitExe} -C ${sourceRepo} init`;
      await $`${gitExe} -C ${parentRepo} init`;
      await setTestGitConfig(sourceRepo, 'user.name', 'Test User');
      await setTestGitConfig(sourceRepo, 'user.email', 'test@example.com');
      await fs.writeFile(path.join(sourceRepo, 'README.md'), 'first\n');
      await $`${gitExe} -C ${sourceRepo} add README.md`;
      await $`${gitExe} -C ${sourceRepo} commit -m ${'cached gitlink first'}`;
      const firstSha = (await $`${gitExe} -C ${sourceRepo} rev-parse HEAD`).stdout.trim();
      await fs.writeFile(path.join(sourceRepo, 'README.md'), 'second\n');
      await $`${gitExe} -C ${sourceRepo} commit -am ${'cached gitlink second'}`;

      await addSubmodule(git$, parentRepo, asUnixPath(sourceRepo), submodulePath);
      await $`${gitExe} -C ${parentRepo} update-index --add --cacheinfo 160000 ${firstSha} ${submodulePath}`;

      const firstRead = await getSubmodules(git$, parentRepo);
      expect(firstRead).toEqual([{ path: submodulePath, status: '+', initialized: true }]);
      const secondRead = await getSubmodules(git$, parentRepo);
      expect(secondRead).toEqual([{ path: submodulePath, status: '+', initialized: true }]);
   });

   it('should refresh a stale cached git path', async () => {
      const { git$ } = createGdxContext(tmpDir, []);
      const gitExe = Array.isArray(git$) ? git$[0] : git$;
      const repoPath = path.join(tmpRootDir, 'reinitialized-git-path-repo');
      const oldGitDir = path.join(tmpRootDir, 'old-git-dir');
      const newGitDir = path.join(tmpRootDir, 'new-git-dir');
      await fs.mkdir(repoPath, { recursive: true });
      await $`${gitExe} init --separate-git-dir ${oldGitDir} ${repoPath}`;

      expect(asUnixPath((await getGitPath(gitExe, repoPath, 'config'))!)).toBe(
         asUnixPath(path.join(oldGitDir, 'config'))
      );

      await fs.unlink(path.join(repoPath, '.git'));
      await $`${gitExe} init --separate-git-dir ${newGitDir} ${repoPath}`;

      expect(asUnixPath((await getGitPath(gitExe, repoPath, 'config'))!)).toBe(
         asUnixPath(path.join(newGitDir, 'config'))
      );
   });

   it('should refresh combined git-path startup queries after git dir replacement', async () => {
      const { git$ } = createGdxContext(tmpDir, []);
      const gitExe = Array.isArray(git$) ? git$[0] : git$;
      const repoPath = path.join(tmpRootDir, 'combined-git-path-repo');
      const oldGitDir = path.join(tmpRootDir, 'combined-old-git-dir');
      const newGitDir = path.join(tmpRootDir, 'combined-new-git-dir');
      const combinedArgs = ['--git-dir', '--git-common-dir', '--show-toplevel'];
      await fs.mkdir(repoPath, { recursive: true });
      await $`${gitExe} init --separate-git-dir ${oldGitDir} ${repoPath}`;

      const before = asUnixPath(await revParseCached([gitExe, '-C', repoPath], combinedArgs));
      expect(before).toContain(asUnixPath(oldGitDir));

      await fs.unlink(path.join(repoPath, '.git'));
      await $`${gitExe} init --separate-git-dir ${newGitDir} ${repoPath}`;

      const after = asUnixPath(await revParseCached([gitExe, '-C', repoPath], combinedArgs));
      expect(after).toContain(asUnixPath(newGitDir));
      expect(after).not.toBe(before);
   });

   it('should refresh repository topology after a dispatch cache boundary', async () => {
      const { git$ } = createGdxContext(tmpDir, []);
      const gitExe = Array.isArray(git$) ? git$[0] : git$;
      const parentRepo = path.join(tmpRootDir, 'topology-parent');
      const nestedRepo = path.join(parentRepo, 'nested');
      const nestedGit = [gitExe, '-C', nestedRepo];
      await fs.mkdir(nestedRepo, { recursive: true });
      await $`${gitExe} -C ${parentRepo} init`;

      expect(asUnixPath(await revParseCached(nestedGit, '--show-toplevel'))).toBe(
         asUnixPath(parentRepo)
      );
      expect(asUnixPath(await getRepoRootCached(nestedGit, true))).toBe(asUnixPath(parentRepo));

      await $`${gitExe} -C ${nestedRepo} init`;
      await (await getCache()).clearOneOff();

      expect(asUnixPath(await revParseCached(nestedGit, '--show-toplevel'))).toBe(
         asUnixPath(nestedRepo)
      );
      expect(asUnixPath(await getRepoRootCached(nestedGit, true))).toBe(asUnixPath(nestedRepo));
   });

   it('should not persist mutable branch, tag, and author caches', async () => {
      const { git$ } = createGdxContext(tmpDir, []);
      const gitExe = Array.isArray(git$) ? git$[0] : git$;
      const repoPath = path.join(tmpRootDir, 'mutable-cache-repo');
      const scopedGit = [gitExe, '-C', repoPath];
      await fs.mkdir(repoPath, { recursive: true });
      await $`${gitExe} -C ${repoPath} init`;
      await setTestGitConfig(repoPath, 'user.name', 'Test User');
      await setTestGitConfig(repoPath, 'user.email', 'test@example.com');
      await $`${gitExe} -C ${repoPath} commit --allow-empty -m ${'mutable cache base'}`;
      const persistentKeysBefore = new Set(
         Object.keys((await (await getCache()).getAll()).entryMeta)
      );

      expect(await getGitBranchesCached(scopedGit)).not.toContain('late-branch');
      expect(await getGitTagsCached(scopedGit)).not.toContain('late-tag');
      expect(await getGitAuthorExistsCached(scopedGit, 'late@example.com')).toBe(false);
      const newPersistentMutableKeys = Object.keys(
         (await (await getCache()).getAll()).entryMeta
      ).filter(
         (key) =>
            !persistentKeysBefore.has(key) &&
            (key.startsWith('git.branches.') ||
               key.startsWith('git.tags.') ||
               key.startsWith('git.author.'))
      );
      expect(newPersistentMutableKeys).toEqual([]);

      await $`${gitExe} -C ${repoPath} branch ${'late-branch'}`;
      await $`${gitExe} -C ${repoPath} tag ${'late-tag'}`;
      await $`${gitExe} -C ${repoPath} -c ${'user.name=Late Author'} -c ${'user.email=late@example.com'} commit --allow-empty -m ${'late author'}`;
      resetCacheService();

      expect(await getGitBranchesCached(scopedGit)).toContain('late-branch');
      expect(await getGitTagsCached(scopedGit)).toContain('late-tag');
      expect(await getGitAuthorExistsCached(scopedGit, 'late@example.com')).toBe(true);
   });

   it('should invalidate native config cache writes', async () => {
      const { git$ } = createGdxContext(tmpDir, []);

      await withInlineGitConfigMode('off', async () => {
         await setGitConfigValue(git$, 'test.native.cached-writer', 'before', {
            repoPath: tmpDir,
         });
         expect(await getGitConfigCached(git$, 'test.native.cached-writer')).toBe('before');

         await setGitConfigValue(git$, 'test.native.cached-writer', 'after', {
            repoPath: tmpDir,
         });
         expect(await getGitConfigCached(git$, 'test.native.cached-writer')).toBe('after');

         await unsetGitConfigValue(git$, 'test.native.cached-writer', { repoPath: tmpDir });
         expect(await getGitConfigCached(git$, 'test.native.cached-writer')).toBe('');
      });
   });

   it('should retry a missing submodule base object after it is fetched', async () => {
      const { git$ } = createGdxContext(tmpDir, []);
      const gitExe = Array.isArray(git$) ? git$[0] : git$;
      const sourceRepo = path.join(tmpRootDir, 'late-submodule-base-source');
      const targetRepo = path.join(tmpRootDir, 'late-submodule-base-target');
      await fs.mkdir(sourceRepo, { recursive: true });
      await fs.mkdir(targetRepo, { recursive: true });
      await $`${gitExe} -C ${sourceRepo} init`;
      await $`${gitExe} -C ${targetRepo} init`;
      await setTestGitConfig(sourceRepo, 'user.name', 'Test User');
      await setTestGitConfig(sourceRepo, 'user.email', 'test@example.com');
      const submoduleSha = (await $`${gitExe} -C ${tmpDir} rev-parse HEAD`).stdout.trim();
      await $`${gitExe} -C ${sourceRepo} update-index --add --cacheinfo ${'160000'} ${submoduleSha} ${'deps/late'}`;
      await $`${gitExe} -C ${sourceRepo} commit -m ${'add late gitlink'}`;
      const baseCommit = (await $`${gitExe} -C ${sourceRepo} rev-parse HEAD`).stdout.trim();

      expect(await getSubmoduleBaseSha(gitExe, targetRepo, baseCommit, 'deps/late')).toBeNull();
      await $`${gitExe} -C ${targetRepo} fetch ${sourceRepo} ${baseCommit}`;
      expect(await getSubmoduleBaseSha(gitExe, targetRepo, baseCommit, 'deps/late')).toBe(
         submoduleSha
      );
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

   it('should invalidate slash branches and @ relative refs when git state changes', async () => {
      const { git$ } = createGdxContext(tmpDir, []);
      const gitExe = Array.isArray(git$) ? git$[0] : git$;
      const repoPath = path.join(tmpRootDir, 'relative-rev-parse-cache');
      const scopedGit = [gitExe, '-C', repoPath];
      await fs.mkdir(repoPath, { recursive: true });
      await $`${gitExe} -C ${repoPath} init`;
      await setTestGitConfig(repoPath, 'user.name', 'Test User');
      await setTestGitConfig(repoPath, 'user.email', 'test@example.com');
      await $`${gitExe} -C ${repoPath} commit --allow-empty -m ${'relative cache first'}`;
      await $`${gitExe} -C ${repoPath} commit --allow-empty -m ${'relative cache second'}`;

      await $`${gitExe} -C ${repoPath} branch ${'feature/cache-target'}`;
      const cache = await getCache();
      const beforeShortBranch = new Set(Object.keys((await cache.getAll()).entryMeta));
      const firstBranch = (await revParseCached(scopedGit, 'feature/cache-target')).trim();
      const afterShortBranch = new Set(Object.keys((await cache.getAll()).entryMeta));
      expect(
         [...afterShortBranch].filter(
            (key) => key.includes('.revParse.') && !beforeShortBranch.has(key)
         )
      ).toEqual([]);
      const firstAt = (await revParseCached(scopedGit, '@')).trim();
      const firstAtRelative = (await revParseCached(scopedGit, '@~1')).trim();
      const firstAtReflog = (await revParseCached(scopedGit, '@{1}')).trim();
      const firstHeadPeel = (await revParseCached(scopedGit, 'HEAD^{}')).trim();
      await $`${gitExe} -C ${repoPath} commit --allow-empty -m ${'relative cache third'}`;
      const latestHead = (await revParseCached(scopedGit, 'HEAD')).trim();
      await $`${gitExe} -C ${repoPath} update-ref refs/heads/feature/cache-target ${latestHead}`;

      const secondBranch = (await revParseCached(scopedGit, 'feature/cache-target')).trim();
      const secondAt = (await revParseCached(scopedGit, '@')).trim();
      const secondAtRelative = (await revParseCached(scopedGit, '@~1')).trim();
      const secondAtReflog = (await revParseCached(scopedGit, '@{1}')).trim();
      const secondHeadPeel = (await revParseCached(scopedGit, 'HEAD^{}')).trim();
      expect(secondBranch).toBe(latestHead);
      expect(secondBranch).not.toBe(firstBranch);
      expect(secondAt).toBe(latestHead);
      expect(secondAt).not.toBe(firstAt);
      expect(secondAtRelative).not.toBe(firstAtRelative);
      expect(secondAtReflog).not.toBe(firstAtReflog);
      expect(secondHeadPeel).not.toBe(firstHeadPeel);
   });

   it('should invalidate short remote refs when remote HEAD moves', async () => {
      const { git$ } = createGdxContext(tmpDir, []);
      const gitExe = Array.isArray(git$) ? git$[0] : git$;
      const repoPath = path.join(tmpRootDir, 'remote-head-ref-cache');
      const remotePath = path.join(tmpRootDir, 'remote-head-ref-cache.git');
      const scopedGit = [gitExe, '-C', repoPath];
      await fs.mkdir(repoPath, { recursive: true });
      await $`${gitExe} -C ${repoPath} init`;
      await setTestGitConfig(repoPath, 'user.name', 'Test User');
      await setTestGitConfig(repoPath, 'user.email', 'test@example.com');
      await $`${gitExe} -C ${repoPath} commit --allow-empty -m ${'remote head first'}`;
      await $`${gitExe} -C ${repoPath} branch ${'remote-alt'}`;
      await $`${gitExe} -C ${repoPath} checkout ${'remote-alt'}`;
      await $`${gitExe} -C ${repoPath} commit --allow-empty -m ${'remote head second'}`;
      const alternateHead = (await $`${gitExe} -C ${repoPath} rev-parse HEAD`).stdout.trim();
      await $`${gitExe} -C ${repoPath} init --bare ${remotePath}`;
      await $`${gitExe} -C ${repoPath} remote add origin ${remotePath}`;
      await $`${gitExe} -C ${repoPath} push origin ${'master'} ${'remote-alt'}`;
      await $`${gitExe} -C ${repoPath} remote set-head origin ${'master'}`;

      await $`${gitExe} -C ${repoPath} branch --set-upstream-to=${'origin/master'} ${'remote-alt'}`;
      const cache = await getCache();
      const beforeRawUpstream = new Set(Object.keys((await cache.getAll()).entryMeta));
      const originalMasterHead = (
         await $`${gitExe} -C ${repoPath} rev-parse refs/remotes/origin/master`
      ).stdout.trim();
      const firstUpstream = (await revParseCached(scopedGit, '@{u}')).trim();
      const afterRawUpstream = new Set(Object.keys((await cache.getAll()).entryMeta));
      expect(firstUpstream).toBe(
         (await $`${gitExe} -C ${repoPath} rev-parse refs/remotes/origin/master`).stdout.trim()
      );
      expect(
         [...afterRawUpstream].filter(
            (key) => key.includes('.revParse.') && !beforeRawUpstream.has(key)
         )
      ).toEqual([]);

      await $`${gitExe} -C ${repoPath} update-ref refs/remotes/origin/master ${alternateHead}`;
      const secondUpstream = (await revParseCached(scopedGit, '@{u}')).trim();
      expect(secondUpstream).toBe(alternateHead);
      const beforeSafeUpstream = new Set(Object.keys((await cache.getAll()).entryMeta));
      const safeUpstream = (
         await revParseCached(scopedGit, ['--abbrev-ref', '--symbolic-full-name', '@{u}'])
      ).trim();
      expect(safeUpstream).toBe('origin/master');
      const afterSafeUpstream = new Set(Object.keys((await cache.getAll()).entryMeta));
      expect(
         [...afterSafeUpstream].some(
            (key) => key.includes('.revParse.') && !beforeSafeUpstream.has(key)
         )
      ).toBe(true);

      await $`${gitExe} -C ${repoPath} update-ref refs/remotes/origin/master ${originalMasterHead}`;
      const beforeShortRemote = new Set(Object.keys((await cache.getAll()).entryMeta));
      const first = (await revParseCached(scopedGit, 'origin')).trim();
      const afterShortRemote = new Set(Object.keys((await cache.getAll()).entryMeta));
      expect(
         [...afterShortRemote].filter(
            (key) => key.includes('.revParse.') && !beforeShortRemote.has(key)
         )
      ).toEqual([]);
      await $`${gitExe} -C ${repoPath} remote set-head origin ${'remote-alt'}`;
      const second = (await revParseCached(scopedGit, 'origin')).trim();

      expect(first).not.toBe(alternateHead);
      expect(second).toBe(alternateHead);
   });

   it('should bypass cache for dynamic rev-parse expressions', async () => {
      const { git$ } = createGdxContext(tmpDir, []);
      const gitExe = Array.isArray(git$) ? git$[0] : git$;
      const repoPath = path.join(tmpRootDir, 'dynamic-rev-parse-cache');
      const scopedGit = [gitExe, '-C', repoPath];
      await fs.mkdir(repoPath, { recursive: true });
      await $`${gitExe} -C ${repoPath} init`;
      await setTestGitConfig(repoPath, 'user.name', 'Test User');
      await setTestGitConfig(repoPath, 'user.email', 'test@example.com');
      await $`${gitExe} -C ${repoPath} commit --allow-empty -m ${'dynamic cache first'}`;

      const cache = await getCache();
      const beforeFirstDynamic = new Set(Object.keys((await cache.getAll()).entryMeta));
      const firstAll = await revParseCached(scopedGit, '--all');
      const firstRange = await revParseCached(scopedGit, 'HEAD~1..HEAD');
      await revParseCached(scopedGit, ['--show-toplevel', 'HEAD']);
      expect(
         Object.keys((await cache.getAll()).entryMeta).filter(
            (key) => key.includes('.revParse.') && !beforeFirstDynamic.has(key)
         )
      ).toEqual([]);
      await $`${gitExe} -C ${repoPath} commit --allow-empty -m ${'dynamic cache second'}`;
      const latestHead = (await revParseCached(scopedGit, 'HEAD')).trim();
      const beforeSecondDynamic = new Set(Object.keys((await cache.getAll()).entryMeta));
      const secondAll = await revParseCached(scopedGit, '--all');
      const secondRange = await revParseCached(scopedGit, 'HEAD~1..HEAD');

      expect(firstAll).not.toContain(latestHead);
      expect(secondAll).toContain(latestHead);
      expect(secondRange).not.toBe(firstRange);
      expect(
         Object.keys((await cache.getAll()).entryMeta).filter(
            (key) => key.includes('.revParse.') && !beforeSecondDynamic.has(key)
         )
      ).toEqual([]);
   });

   it('should invalidate HEAD cache from its symbolic branch ref without reflogs', async () => {
      const { git$ } = createGdxContext(tmpDir, []);
      const gitExe = Array.isArray(git$) ? git$[0] : git$;
      const repoPath = path.join(tmpRootDir, 'head-symbolic-ref-cache');
      await fs.mkdir(repoPath, { recursive: true });
      await $`${gitExe} -C ${repoPath} init`;
      await setTestGitConfig(repoPath, 'user.name', 'Test User');
      await setTestGitConfig(repoPath, 'user.email', 'test@example.com');
      await $`${gitExe} -C ${repoPath} config core.logAllRefUpdates false`;
      await $`${gitExe} -C ${repoPath} commit --allow-empty -m ${'symbolic head first'}`;

      const first = (await revParseCached(git$, 'HEAD', repoPath)).trim();
      await $`${gitExe} -C ${repoPath} commit --allow-empty -m ${'symbolic head second'}`;
      const second = (await revParseCached(git$, 'HEAD', repoPath)).trim();

      expect(second).toBeTruthy();
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
