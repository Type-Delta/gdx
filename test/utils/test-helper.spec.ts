import { expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTestEnv } from '@/utils/testHelper';

it('anchors test environments to the repository when cwd changes', async () => {
   const originalCwd = process.cwd();
   const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdx-test-helper-cwd-'));
   let cleanup = () => {};

   try {
      process.chdir(outsideDir);
      const env = await createTestEnv();
      cleanup = env.cleanup;

      expect(path.dirname(env.tmpRootDir)).toBe(path.resolve(import.meta.dir, '../env'));
   } finally {
      process.chdir(originalCwd);
      cleanup();
      fs.rmSync(outsideDir, { recursive: true, force: true });
   }
});
