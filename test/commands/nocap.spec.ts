import { describe, expect } from 'bun:test';

import fs from 'fs/promises';
import path from 'path';

import nocap from '@/commands/nocap';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';

describe('gdx nocap', async () => {
   const { tmpDir, $, buffer, it } = await createTestEnv({
      suitName: 'nocap'
   });
   const ctx = createGdxContext(tmpDir);
   const { git$ } = ctx;

   it('should return 1 when no commits exist', async () => {
      const emptyDir = path.join(tmpDir, 'empty_repo');
      await fs.mkdir(emptyDir);
      await $`git init ${emptyDir}`;
      const emptyCtx = createGdxContext(emptyDir);

      const result = await nocap(emptyCtx);
      expect(result).toBe(1);
   });

   it('should print the original commit message before the roast when a commit exists', async () => {
      // Create a commit
      await $`${git$} commit --allow-empty --no-verify -m ${'My Initial commit'}`;

      const result = await nocap(ctx);
      const output = buffer.stdout;
      const cmiMsgPos = output.indexOf('My Initial commit');
      const roastPos = output.indexOf('Mock response from LLM');

      expect(result).toBe(0);
      expect(cmiMsgPos).toBeGreaterThan(-1);
      expect(roastPos).toBeGreaterThan(-1);
      expect(cmiMsgPos).toBeLessThan(roastPos);
   });
});
