import { afterAll, describe, expect } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';

import reword from '@/commands/reword';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';
import { getConfig } from '@/common/config';

describe.concurrent('gdx reword', async () => {
   const { tmpDir, $, tracker, cleanup, it, resetRepo } = await createTestEnv();

   afterAll(cleanup);

   it('rewords the latest commit using configured editor', async () => {
      await resetRepo();

      const filePath = path.join(tmpDir, 'note.txt');
      await fs.writeFile(filePath, 'alpha');
      await $`git add note.txt`;
      await $`git commit -m ${'initial message'}`;

      const { stdout: beforeEditor } = await $`git config --get core.editor`.catch(() => ({
         stdout: '',
      }));
      expect(beforeEditor.trim()).toBe('');

      const config = await getConfig();
      await config.set('reword.editor', 'bun run dummy-editor --');
      await config.save();

      const ctx = createGdxContext(tmpDir, ['reword']);
      const result = await reword(ctx);

      expect(result).toBe(0);
      expect(tracker.openedPaths.length).toBe(0);

      const message = (await $`git log -1 --format=%B`).stdout.trim();
      expect(message).toBe('initial message');
   });
});
