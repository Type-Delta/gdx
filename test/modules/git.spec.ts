import { afterAll, describe, expect } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';

import { getMainWorktreeRoot } from '@/modules/git';
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
});
