import { afterAll, describe, expect, mock } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';

import { createGdxContext, createTestEnv } from '@/utils/testHelper';
import { normalizePath } from '@/utils/utilities';
import { stripAnsiColor } from '@/modules/graphics';

let capturedPreview = '';

mock.module('@/modules/diff-viewer', () => ({
   viewDiff: async (content: string) => {
      capturedPreview = content;
      return { action: 'skip', key: 's' };
   },
}));

describe('gdx parallel join conflict preview', async () => {
   const { tmpDir, tmpRootDir, $, cleanup, it, env } = await createTestEnv({
      autoResetBuffer: true,
   });
   const { git$ } = createGdxContext(tmpDir);
   const { default: parallel } = await import('@/commands/parallel');

   afterAll(cleanup);

   it('should include conflict files in interactive preview', async () => {
      capturedPreview = '';
      env.isTTY = true;

      await fs.writeFile(path.join(tmpDir, 'conflict.txt'), 'base\n');
      await $`${git$} add conflict.txt`;
      await $`${git$} commit -m ${'Add conflict base'}`;

      const alias = 'conflict-preview';
      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias]);
      expect(await parallel(forkCtx)).toBe(0);

      const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
      const projectName = path.basename(tmpDir);
      const worktreeRoot = path.join(
         tmpRootDir,
         'tmp',
         'worktrees',
         normalizePath(projectName),
         normalizePath(branchName)
      );
      const forkPath = path.join(worktreeRoot, alias);

      await fs.writeFile(path.join(tmpDir, 'conflict.txt'), 'origin change\n');
      await $`${git$} -C ${tmpDir} add conflict.txt`;
      await $`${git$} -C ${tmpDir} commit -m ${'Origin change'}`;

      await fs.writeFile(path.join(forkPath, 'conflict.txt'), 'fork change\n');
      await $`${git$} -C ${forkPath} add conflict.txt`;
      await $`${git$} -C ${forkPath} commit -m ${'Fork change'}`;

      const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', alias, '-i', '--keep']);
      expect(await parallel(joinCtx)).toBe(0);

      const previewText = stripAnsiColor(capturedPreview);
      expect(previewText).toContain('Conflicts:');
      expect(previewText).toContain('conflict.txt');
      const conflictIndex = previewText.indexOf('Conflicts:');
      const conflictSummary = conflictIndex === -1 ? '' : previewText.slice(conflictIndex);
      if (conflictSummary.includes('|')) {
         expect(conflictSummary).toMatch(/conflict\.txt\s*\|\s*\d+\s+conflict/);
      }

      const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', alias]);
      await parallel(removeCtx);
   });
});
