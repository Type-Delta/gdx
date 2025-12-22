import { afterAll, describe, it, expect } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';

import commit from '@/commands/commit';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';

describe('gdx commit', async () => {
   const { tmpDir, $, buffer, cleanup } = await createTestEnv();
   const ctx = createGdxContext(tmpDir);

   afterAll(cleanup);

   it('should fail if no staged changes', async () => {
      const result = await commit.auto(ctx);
      expect(result).toBe(1);
      expect(buffer.stdout).toContain('No staged changes found');
   });

   it('should generate commit message and commit', async () => {
      // Create and stage a file
      await fs.writeFile(path.join(tmpDir, 'newfile.txt'), 'content');
      await $`git -C ${tmpDir} add newfile.txt`;

      buffer.stdout = '';
      const result = await commit.auto(ctx);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain('Generated Commit Message');

      // Verify commit was made
      const log = (await $`git -C ${tmpDir} log -1 --pretty=%B`).stdout;
      expect(log).toContain('Mock response from LLM'); // Assuming mock LLM is used
   });

   it('should respect --no-commit flag', async () => {
      // Modify file and stage
      await fs.writeFile(path.join(tmpDir, 'newfile.txt'), 'modified content');
      await $`git -C ${tmpDir} add newfile.txt`;

      buffer.stdout = '';
      const ncCtx = createGdxContext(tmpDir, ['--no-commit']);
      const result = await commit.auto(ncCtx);

      expect(result).toBe(0);

      // Verify NO commit was made (HEAD should be same as before)
      // But wait, previous test made a commit.
      // Let's check if changes are still staged.
      const status = (await $`git -C ${tmpDir} status --porcelain`).stdout;
      expect(status).toContain('M  newfile.txt');
   });
});
