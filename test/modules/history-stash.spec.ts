import { describe, expect } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';

import { dispatch } from '@/cli/dispatch';
import { readHistoryTimeline, resolveHistoryStoragePaths } from '@/modules/history/storage';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';

describe('stash drop history compatibility', async () => {
   const { tmpDir, $, it, resetRepo } = await createTestEnv({ suitName: 'history-stash' });
   const ctx = createGdxContext(tmpDir);

   it('uses the latest compatible history transaction before legacy pardon fallback', async () => {
      await resetRepo('full');
      const paths = await resolveHistoryStoragePaths(ctx.git$);
      await fs.rm(paths.historyDir, { recursive: true, force: true });
      const file = path.join(tmpDir, 'stash.txt');
      await fs.writeFile(file, 'base\n');
      await $`${ctx.git$} add stash.txt`;
      await $`${ctx.git$} commit --no-verify -m ${'stash base'}`;
      await fs.writeFile(file, 'stashed\n');
      await $`${ctx.git$} stash push -m ${'history stash'}`;

      expect(await dispatch(createGdxContext(tmpDir, ['stash', 'drop', 'stash@{0}']))).toBe(0);
      expect((await $`${ctx.git$} stash list`).stdout.trim()).toBe('');
      expect((await readHistoryTimeline(ctx.git$)).cursor).toBe(1);

      expect(await dispatch(createGdxContext(tmpDir, ['stash', 'drop', 'pardon']))).toBe(0);
      expect((await $`${ctx.git$} stash list`).stdout).toContain('history stash');
      expect((await readHistoryTimeline(ctx.git$)).cursor).toBe(0);
   });
});
