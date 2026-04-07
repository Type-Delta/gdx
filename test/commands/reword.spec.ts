import { describe, expect } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';

import reword from '@/commands/reword';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';
import { getConfig } from '@/common/config';
import { $ as shell$ } from '@/modules/shell';

async function readCommitMessage(repoPath: string, ref: string): Promise<string> {
   const $ = shell$({ cwd: repoPath });
   const sha = (await $`git rev-parse ${ref}`).stdout.trim();
   const rawCommit = (await $`git cat-file -p ${sha}`).stdout;
   const separatorIndex = rawCommit.indexOf('\n\n');
   if (separatorIndex < 0) return '';
   return rawCommit.slice(separatorIndex + 2);
}

async function configureRewordEditor(projectDir: string, message: string): Promise<void> {
   const editorPath = path.join(projectDir, 'test-reword-editor.mjs');
   await fs.writeFile(
      editorPath,
      `import { writeFile } from 'fs/promises';

const targetFile = process.argv[process.argv.length - 1];
await writeFile(targetFile, ${JSON.stringify(message)}, 'utf8');
`
   );

   const config = await getConfig();
   await config.set('reword.editor', `bun ${editorPath}`);
   await config.save();
}

describe('gdx reword', async () => {
   const { tmpDir, $, tracker, it, resetRepo } = await createTestEnv();

   it('rewords the latest commit message exactly', async () => {
      await resetRepo();

      const filePath = path.join(tmpDir, 'note.txt');
      await fs.writeFile(filePath, 'alpha');
      await $`git add note.txt`;
      await $`git commit -m ${'initial subject'} -m ${'initial body line'}`;

      const expectedMessage = 'updated subject\n\nupdated body line 1\nupdated body line 2';
      await configureRewordEditor(tmpDir, expectedMessage);

      const ctx = createGdxContext(tmpDir, ['reword']);
      const result = await reword(ctx);

      expect(result).toBe(0);
      expect(tracker.openedPaths.length).toBe(0);

      const message = await readCommitMessage(tmpDir, 'HEAD');
      expect(message).toBe(expectedMessage);
   });

   it('rewords an older commit message exactly and keeps working tree changes', async () => {
      await resetRepo();

      const filePath = path.join(tmpDir, 'note.txt');
      await fs.writeFile(filePath, 'alpha');
      await $`git add note.txt`;
      await $`git commit -m ${'first subject'} -m ${'first body line'}`;

      await fs.writeFile(filePath, 'beta');
      await $`git add note.txt`;
      await $`git commit -m ${'second subject'} -m ${'second body line'}`;

      const originalLatestMessage = await readCommitMessage(tmpDir, 'HEAD');

      const commitsBefore = Number((await $`git rev-list --count HEAD`).stdout.trim());

      await fs.writeFile(filePath, 'local unstaged change');

      const expectedOlderMessage = 'rewritten first subject\n\nrewritten first body';
      await configureRewordEditor(tmpDir, expectedOlderMessage);

      const ctx = createGdxContext(tmpDir, ['reword', '~1']);
      const result = await reword(ctx);

      expect(result).toBe(0);

      const latestMessage = await readCommitMessage(tmpDir, 'HEAD');
      const olderMessage = await readCommitMessage(tmpDir, 'HEAD~1');
      expect(latestMessage).toBe(originalLatestMessage);
      expect(olderMessage).toBe(expectedOlderMessage);

      const commitsAfter = Number((await $`git rev-list --count HEAD`).stdout.trim());
      expect(commitsAfter).toBe(commitsBefore);

      const status = (await $`git status --porcelain`).stdout;
      expect(status).toContain(' M note.txt');
   });
});
