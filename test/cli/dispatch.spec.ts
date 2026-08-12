import { describe, expect } from 'bun:test';
import path from 'path';

import { dispatch } from '@/cli/dispatch';
import { getCache } from '@/common/cache';
import * as fs from '@/modules/fs';
import { execGit } from '@/modules/shell';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';

describe('dispatch separator forwarding', async () => {
   const { tmpDir, $, it, resetRepo } = await createTestEnv({ suitName: 'dispatch-separator' });
   it('passes `--` through normal git dispatch', async () => {
      fs.writeFileSync(path.join(tmpDir, 'README.md'), 'hello world');
      await $`git add README.md`;
      await $`git commit --no-verify -m ${'Add README'}`;
      await $`git branch README.md`;

      const exitCode = await dispatch(createGdxContext(tmpDir, ['log', '--', 'README.md']));

      expect(exitCode).toBe(0);
   });

   it('passes `--` through bypass-style git execution unchanged', async () => {
      await resetRepo('full');
      fs.writeFileSync(path.join(tmpDir, 'README.md'), 'hello world');
      await $`git add README.md`;
      await $`git commit --no-verify -m ${'Add README'}`;
      await $`git branch README.md`;

      const ctx = createGdxContext(tmpDir, ['--bypass', 'log', '--', 'README.md']);
      const exitCode = await execGit(ctx.git$, ctx.args.slice(1));

      expect(exitCode).toBe(0);
   });
});

describe('worktree dispatch', async () => {
   const { tmpDir, it } = await createTestEnv({ suitName: 'dispatch-worktree' });

   it('progressively matches the worktree command and its subcommand', async () => {
      const exitCode = await dispatch(createGdxContext(tmpDir, ['wor', 'li']));

      expect(exitCode).toBe(0);
   });

   it('supports wt as an alias for worktree', async () => {
      const exitCode = await dispatch(createGdxContext(tmpDir, ['wt', 'ls']));

      expect(exitCode).toBe(0);
   });
});

describe('dispatch one-off cache lifetime', async () => {
   const { tmpDir, it } = await createTestEnv({
      suitName: 'dispatch-one-off-cache',
      liteMode: true,
   });

   it('clears one-off cache for top-level and consecutive macro dispatches', async () => {
      const cache = await getCache();
      await cache.setOneOff('dispatch.test', 'top-level');

      expect(await dispatch(createGdxContext(tmpDir, ['macro', 'list']))).toBe(0);
      expect(await cache.getOneOff('dispatch.test')).toBeUndefined();

      await cache.setOneOff('dispatch.test', 'first-macro-command');
      expect(await dispatch(createGdxContext(tmpDir, ['macro', 'list']), { inMacro: true })).toBe(0);
      expect(await cache.getOneOff('dispatch.test')).toBeUndefined();
   });
});
