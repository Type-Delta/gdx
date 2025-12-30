import { afterAll, describe } from 'bun:test';
import { expect } from 'chai';

import fs from 'fs/promises';
import path from 'path';

import nocap from '@/commands/nocap';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';

describe('gdx nocap', async () => {
   const { tmpDir, $, buffer, cleanup, it } = await createTestEnv({ autoResetBuffer: false });
   const ctx = createGdxContext(tmpDir);
   const { git$ } = ctx;
   afterAll(cleanup);

   let result: number;
   it('should return 1 when no commits exist', async () => {
      const emptyDir = path.join(tmpDir, 'empty_repo');
      await fs.mkdir(emptyDir);
      await $`git init ${emptyDir}`;
      const emptyCtx = createGdxContext(emptyDir);

      result = await nocap(emptyCtx);
      expect(result).to.equal(1);
   });

   it('should return 0 when a commit exists', async () => {
      // Create a commit
      await $`${git$} commit --allow-empty -m ${'My Initial commit'}`;
      buffer.stdout = '';
      buffer.stderr = '';

      result = await nocap(ctx);
      expect(result).to.equal(0);
   });

   it('should print the roast to stdout', async () => {
      // output is captured in the test environment.
      const output = buffer.stdout;
      expect(output, 'Missing llm response').to.include('Mock response from LLM');
   });

   it('should print the original commit message', async () => {
      const output = buffer.stdout;
      const cmiMsgPos = output.indexOf('My Initial commit');
      const roastPos = output.indexOf('Mock response from LLM');
      expect(cmiMsgPos, 'Missing original commit message').to.be.greaterThan(-1);
      expect(roastPos, 'Missing roast message').to.be.greaterThan(-1);
      expect(cmiMsgPos, 'Missing or out of order messages').to.be.lessThan(roastPos);
   });
});
