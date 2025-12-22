import { afterAll, describe, it, expect } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';

import parallel from '@/commands/parallel';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';

describe('gdx parallel', async () => {
   const { tmpDir, $, buffer, cleanup } = await createTestEnv();
   afterAll(cleanup);

   it('should list empty worktrees initially', async () => {
      const listCtx = createGdxContext(tmpDir, ['list']);
      buffer.stdout = '';

      const result = await parallel(listCtx);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain('No parallel worktrees found');
   });

   it('should fork a new worktree', async () => {
      // Need a commit to branch off
      await $`git -C ${tmpDir} commit --allow-empty -m ${'Initial commit'}`;

      const forkCtx = createGdxContext(tmpDir, ['fork', 'feature-1']);
      buffer.stdout = '';

      const result = await parallel(forkCtx);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain("Parallel worktree 'feature-1' created");

      // Verify directory exists
      const worktreePath = path.join(tmpDir, 'worktrees', path.basename(tmpDir), 'feature-1');
      const exists = await fs
         .stat(worktreePath)
         .then(() => true)
         .catch(() => false);
      expect(exists).toBe(true);
   });

   it('should list active worktrees', async () => {
      const listCtx = createGdxContext(tmpDir, ['list']);
      buffer.stdout = '';

      const result = await parallel(listCtx);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain('feature-1');
   });

   it('should fail to fork with invalid alias', async () => {
      const forkCtx = createGdxContext(tmpDir, ['fork', 'invalid/name']);
      buffer.stdout = '';

      const result = await parallel(forkCtx);

      expect(result).toBe(1);
      expect(buffer.stdout).toContain('Invalid alias');
   });

   it('should remove a worktree', async () => {
      const removeCtx = createGdxContext(tmpDir, ['remove', 'feature-1']);
      buffer.stdout = '';

      const result = await parallel(removeCtx);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain('removed');

      // Verify directory is gone
      const worktreePath = path.join(tmpDir, 'worktrees', path.basename(tmpDir), 'feature-1');
      const exists = await fs
         .stat(worktreePath)
         .then(() => true)
         .catch(() => false);
      expect(exists).toBe(false);
   });
});
