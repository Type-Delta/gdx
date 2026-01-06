import { afterAll, describe } from 'bun:test';
import fs from 'fs/promises';
import { expect } from 'chai';

import stash from '@/commands/stash';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';
import { noop } from '@/utils/utilities';

describe('gdx stash drop X..Y (stash.dropRange())', async () => {
   const { tmpDir, $, buffer, cleanup, it } = await createTestEnv();
   const ctx = createGdxContext(tmpDir);
   const { git$ } = ctx;
   afterAll(cleanup);

   // create initial commits
   await $`${git$} commit --allow-empty -m ${'Initial commit'}`;

   // create some stashes
   for (let i = 0; i < 5; i++) {
      await fs.writeFile(`${tmpDir}/file${i}.txt`, `Content for file ${i}`);
      await $`${git$} add .`;
      await $`${git$} stash push -m ${`Stash ${i}`}`;
   }

   it('should drop stashes in the specified range', async () => {
      const result = await stash.dropRange(ctx.git$, ['stash', 'drop', '1..3'], 10);
      expect(result).to.equal(0);

      // Verify remaining stashes
      const { stdout } = await $`${git$} stash list`;
      const stashes = stdout
         .trim()
         .split('\n')
         .map((line) => line.split(':')[0]);
      expect(stashes).to.deep.equal(['stash@{0}', 'stash@{1}']); // only stash@{0} and stash@{1} should remain
   });

   it('should return error code when given an invalid range', async () => {
      buffer.stdout = ''; // Clear buffer before test
      const result = await stash.dropRange(ctx.git$, ['stash', 'drop', '3..1'], 10);

      expect(result).to.equal(1);
   });
});

describe('gdx stash drop pardon', async () => {
   const { tmpDir, $, cleanup, it } = await createTestEnv();
   const ctx = createGdxContext(tmpDir);
   const { git$ } = ctx;

   // Helper to setup some stashes
   const setupStashes = async (count: number) => {
      // Clear existing stashes
      await $`${git$} stash clear`.catch(noop);

      for (let i = 0; i < count; i++) {
         await fs.writeFile(`${tmpDir}/file${i}.txt`, `Content for file ${i} - ${Date.now()}`);
         await $`${git$} add .`;
         await $`${git$} stash push -m ${`Stash ${i}`}`;
      }
   };

   afterAll(cleanup);

   it('should drop a single stash and restore it with pardon', async () => {
      await setupStashes(3);

      let res = await stash.drop(ctx.git$, ['stash', 'drop', '0']);
      expect(res).to.equal(0);

      // Verify drop
      let { stdout } = await $`${git$} stash list`;
      expect(stdout).to.not.include('Stash 2');
      expect(stdout).to.include('Stash 1');

      // Pardon
      res = await stash.drop(ctx.git$, ['stash', 'drop', 'pardon']);
      expect(res).to.equal(0);

      // Verify restore
      ({ stdout } = await $`${git$} stash list`);
      expect(stdout).to.include('Stash 2');
      expect(stdout).to.include('Stash 1');
   });

   it('should drop a range of stashes and restore them with pardon', async () => {
      await setupStashes(5);

      let res = await stash.drop(ctx.git$, ['stash', 'drop', '1..3']);
      expect(res).to.equal(0);

      let { stdout } = await $`${git$} stash list`;
      expect(stdout).to.not.include('Stash 3');
      expect(stdout).to.not.include('Stash 2');
      expect(stdout).to.not.include('Stash 1');
      expect(stdout).to.include('Stash 4');
      expect(stdout).to.include('Stash 0');

      // Pardon
      res = await stash.drop(ctx.git$, ['stash', 'drop', 'pardon']);
      expect(res).to.equal(0);

      // Verify restore
      ({ stdout } = await $`${git$} stash list`);
      expect(stdout).to.include('Stash 3');
      expect(stdout).to.include('Stash 2');
      expect(stdout).to.include('Stash 1');
   });

   it('should fail gracefully when nothing to pardon', async () => {
      const res = await stash.drop(ctx.git$, ['stash', 'drop', 'pardon']);
      expect(res).to.equal(1);
   });
});
