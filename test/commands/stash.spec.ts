import { afterAll, describe, it } from 'bun:test';
import fs from 'fs/promises';
import { expect } from 'chai';

import stash from '@/commands/stash';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';

describe('gdx stash drop X..Y (stash.dropRange())', async () => {
   const { tmpDir, $, buffer, cleanup } = await createTestEnv();
   const ctx = createGdxContext(tmpDir);
   afterAll(cleanup);

   // create initial commits
   await $`git -C ${tmpDir} commit --allow-empty -m ${'Initial commit'}`;

   // create some stashes
   for (let i = 0; i < 5; i++) {
      await fs.writeFile(`${tmpDir}/file${i}.txt`, `Content for file ${i}`);
      await $`git -C ${tmpDir} add .`;
      await $`git -C ${tmpDir} stash push -m ${`Stash ${i}`}`;
   }

   it('should drop stashes in the specified range', async () => {
      const result = await stash.dropRange(ctx.git$, ['stash', 'drop', '1..3']);
      expect(result).to.equal(0);

      // Verify remaining stashes
      const { stdout } = await $`git -C ${tmpDir} stash list`;
      const stashes = stdout
         .trim()
         .split('\n')
         .map((line) => line.split(':')[0]);
      expect(stashes).to.deep.equal(['stash@{0}', 'stash@{1}']); // only stash@{0} and stash@{1} should remain
   });

   it('should return error code when given an invalid range', async () => {
      buffer.stdout = '';
      const result = await stash.dropRange(ctx.git$, ['stash', 'drop', '3..1']);

      expect(buffer.stdout).to.include('Invalid stash range: 3..1');
      expect(result).to.equal(1);
   });
});
