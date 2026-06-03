import { describe, expect } from 'bun:test';
import path from 'path';

import { dispatch } from '@/cli/dispatch';
import * as fs from '@/modules/fs';
import { execGit } from '@/modules/shell';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';

describe('dispatch separator forwarding', async () => {
   const { tmpDir, $, it } = await createTestEnv({ suitName: 'dispatch-separator' });

   it('passes `--` through normal git dispatch', async () => {
      fs.writeFileSync(path.join(tmpDir, 'README.md'), 'hello world');
      await $`git add README.md`;
      await $`git commit --no-verify -m ${'Add README'}`;

      const exitCode = await dispatch(createGdxContext(tmpDir, ['log', '--', 'README.md']));

      expect(exitCode).toBe(0);
   });

   it('passes `--` through bypass-style git execution unchanged', async () => {
      const ctx = createGdxContext(tmpDir, ['--bypass', 'log', '--', 'README.md']);
      const exitCode = await execGit(ctx.git$, ctx.args.slice(1));

      expect(exitCode).toBe(0);
   });
});
