import { afterAll, describe, expect } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';

import commit from '@/commands/commit';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';

describe('gdx commit auto', async () => {
   const { tmpDir, $, buffer, cleanup, it } = await createTestEnv();
   const ctx = createGdxContext(tmpDir, ['commit', 'auto']);
   afterAll(cleanup);

   it('should fail if no staged changes', async () => {
      const result = await commit.auto(ctx);
      expect(result).toBe(1);
      expect(buffer.stdout).toContain('No staged changes found');
   });

   it('should generate commit message and commit', async () => {
      // Set dummy editor to simulate open and close action from user
      await $`git -C ${tmpDir} config core.editor ${'bun run dummy-editor --'}`;

      // Create and stage a file
      await fs.writeFile(path.join(tmpDir, 'newfile.txt'), 'content');
      await $`git -C ${tmpDir} add newfile.txt`;

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

      const ncCtx = createGdxContext(tmpDir, ['commit', 'auto', '--no-commit']);
      const result = await commit.auto(ncCtx);

      expect(result).toBe(0);

      // Verify NO commit was made (HEAD should be same as before)
      const status = (await $`git -C ${tmpDir} status --porcelain`).stdout;
      expect(status).toContain('M  newfile.txt');
   });
});
