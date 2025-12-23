import { afterAll, describe, expect } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';

import parallel from '@/commands/parallel';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';

describe('gdx parallel', async () => {
   const { tmpDir, tmpRootDir, $, buffer, cleanup, it } = await createTestEnv();
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
      await $`git -C ${tmpDir} commit --allow-empty -m ${'Initial commit'}`;

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
      expect(buffer.stdout).toContain('contains invalid characters');
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
});
