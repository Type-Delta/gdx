import { afterAll, describe, expect } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';

import { deinitSubmodules, getMainWorktreeRoot, isEmptyCherryPickError } from '@/modules/git';
import { createTestEnv, createGdxContext } from '@/utils/testHelper';

describe('git module', async () => {
   const { tmpDir, tmpRootDir, $, cleanup, it } = await createTestEnv();
   afterAll(cleanup);

   it('should resolve main worktree root from .git file worktree', async () => {
      const worktreeDir = path.join(tmpRootDir, 'wt-case');
      await $`git worktree add ${worktreeDir} -b ${'worktree-test'}`;

      const gitFilePath = path.join(worktreeDir, '.git');
      const gitFileContent = await fs.readFile(gitFilePath, 'utf-8');
      expect(gitFileContent.toLowerCase()).toContain('gitdir:');

      const wtCtx = createGdxContext(worktreeDir, []);
      const mainRoot = await getMainWorktreeRoot(wtCtx.git$);

      expect(mainRoot.replace(/\\/g, '/')).toBe(tmpDir.replace(/\\/g, '/'));
   });

   it('should deinit submodules for a worktree', async () => {
      const { git$ } = createGdxContext(tmpDir, []);
      const gitExe = Array.isArray(git$) ? git$[0] : git$;
      const submoduleRoot = path.join(tmpRootDir, 'submodule-clean');
      await fs.mkdir(submoduleRoot, { recursive: true });
      await $`${gitExe} -C ${submoduleRoot} init`;
      await $`${gitExe} -C ${submoduleRoot} config user.name ${'Test User'}`;
      await $`${gitExe} -C ${submoduleRoot} config user.email ${'test@example.com'}`;
      await fs.writeFile(path.join(submoduleRoot, 'README.md'), 'submodule');
      await $`${gitExe} -C ${submoduleRoot} add README.md`;
      await $`${gitExe} -C ${submoduleRoot} commit -m ${'init submodule'}`;

      const submoduleUrl = submoduleRoot.replace(/\\/g, '/');
      await $`${gitExe} -C ${tmpDir} -c protocol.file.allow=always submodule add ${submoduleUrl} ${'deps/submodule'}`;
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
   });

   it('should detect empty cherry-pick errors from output text', async () => {
      const err = {
         stderr: 'The previous cherry-pick is now empty, possibly due to conflict resolution.',
      };
      expect(isEmptyCherryPickError(err)).toBe(true);
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
});
