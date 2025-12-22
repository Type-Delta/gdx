import { afterAll, describe, it, expect } from 'bun:test';
import graph from '@/commands/graph';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';

describe('gdx graph', async () => {
   const { tmpDir, $, buffer, cleanup } = await createTestEnv();
   const ctx = createGdxContext(tmpDir);

   afterAll(cleanup);

   it('should fail if no email configured (and not provided)', async () => {
      // Unset email
      try {
         await $`git -C ${tmpDir} config --unset user.email`;

         const result = await graph(ctx);
         expect(result).toBe(1);
         expect(buffer.stdout).toContain('User email not configured');
      } finally {
         // Restore email for next tests
         await $`git -C ${tmpDir} config user.email "test@example.com"`;
      }
   });

   it('should generate graph for empty repo', async () => {
      const result = await graph(ctx);
      expect(result).toBe(0);
      // Should print something about generating graph
      expect(buffer.stdout).toContain('Generating commit graph');
   });

   it('should generate graph with commits', async () => {
      // Create some commits
      await $`git -C ${tmpDir} commit --allow-empty -m ${'commit 1'}`;
      await $`git -C ${tmpDir} commit --allow-empty -m ${'commit 2'}`;
      const result = await graph(ctx);

      expect(result).toBe(0);
      // We expect some output. The graph uses special chars, but we can check for "Generating commit graph"
      expect(buffer.stdout).toContain('Generating commit graph');
   });

   it('should respect --email flag', async () => {
      const emailCtx = createGdxContext(tmpDir, ['graph', '--email', 'other@example.com']);
      buffer.stdout = '';

      const result = await graph(emailCtx);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain('other@example.com');
   });
});
