import { describe, expect } from 'bun:test';

import { dispatch } from '@/cli/dispatch';
import { cleanString } from '@lib/Tools';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';

describe('dispatch help flags for gdx commands', async () => {
   const { buffer, it, tmpDir } = await createTestEnv({
      liteMode: true,
      suitName: 'dispatch-help-flags',
   });

   it('prints built-in help for custom commands with -h', async () => {
      const exitCode = await dispatch(createGdxContext(tmpDir, ['cache', '-h']));

      expect(exitCode).toBe(0);
      expect(cleanString(buffer.stdout)).toContain('Manually manage gdx cache entries and settings.');
   });

   it('prints built-in help for command extensions with --help', async () => {
      const exitCode = await dispatch(createGdxContext(tmpDir, ['status', '--help']));

      expect(exitCode).toBe(0);
      expect(cleanString(buffer.stdout)).toContain(
         'Show the working tree status for the repository and optionally all submodules.'
      );
   });
});
