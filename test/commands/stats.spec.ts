import { afterAll, describe, it, expect } from 'bun:test';
import stats from '@/commands/stats';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';

describe('gdx stats', async () => {
   const { tmpDir, $, buffer, cleanup } = await createTestEnv();
   const ctx = createGdxContext(tmpDir);

   afterAll(cleanup);

   it('should fail if no email configured (and not provided)', async () => {
      await $`git -C ${tmpDir} config --unset user.email`;

      const result = await stats(ctx);
      expect(result).toBe(1);
      expect(buffer.stdout).toContain('Failed to read git config user.email');

      await $`git -C ${tmpDir} config user.email "test@example.com"`;
   });

   it('should calculate stats for empty repo', async () => {
      buffer.stdout = '';
      const result = await stats(ctx);

      expect(result).toBe(0);
      // Should print stats (likely 0 commits)
      expect(buffer.stdout).toContain('Total Commits');
   });

   it('should calculate stats with commits', async () => {
      await $`git -C ${tmpDir} commit --allow-empty -m ${'commit 1'}`;
      buffer.stdout = '';
      const result = await stats(ctx);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain('Total Commits');
      // We can't easily parse the output as it might be formatted, but we can check for presence of key strings.
   });

   it('should respect --author flag', async () => {
      const authorCtx = createGdxContext(tmpDir, ['--author', 'other@example.com']);
      buffer.stdout = '';

      const result = await stats(authorCtx);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain('other@example.com');
   });
});
