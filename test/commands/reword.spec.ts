import { describe, expect } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';

import reword from '@/commands/reword';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';
import { getConfig } from '@/common/config';
import { $ as shell$ } from '@/modules/shell';
import { resetConfig } from '@/common/config';

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

async function configureFakeCodeEditor(projectDir: string, message: string): Promise<string> {
   const fakeEditorDir = path.join(projectDir, 'fake-code-editor');
   const editorScriptPath = path.join(fakeEditorDir, 'fake-code-editor.mjs');
   const argsPath = path.join(fakeEditorDir, 'args.txt');
   const editorPath = path.join(fakeEditorDir, process.platform === 'win32' ? 'code.cmd' : 'code');

   await fs.mkdir(fakeEditorDir, { recursive: true });
   await fs.writeFile(
      editorScriptPath,
      `import { writeFile } from 'fs/promises';

const args = process.argv.slice(2);
await writeFile(${JSON.stringify(argsPath)}, args.join('\\n'), 'utf8');
await writeFile(args[args.length - 1], ${JSON.stringify(message)}, 'utf8');
`
   );

   await fs.writeFile(
      editorPath,
      process.platform === 'win32'
         ? `@echo off\r\nbun "%~dp0fake-code-editor.mjs" %*\r\n`
         : `#!/usr/bin/env sh\nbun "$(dirname "$0")/fake-code-editor.mjs" "$@"\n`
   );

   if (process.platform !== 'win32') {
      await fs.chmod(editorPath, 0o755);
   }

   const config = await getConfig();
   await config.reset('reword.editor');
   await config.set('defaultEditor', `${editorPath} --reuse-window`);
   await config.save();

   return argsPath;
}

describe('gdx reword', async () => {
   const { tmpDir, $, tracker, buffer, it, resetRepo } = await createTestEnv({
      suitName: 'reword',
      overwrites: {
         openInEditor: false, // Use the actual openInEditor behavior to test the editor integration
      }
   });

   it('rewords the latest commit message exactly', async () => {
      await resetRepo();

      await $`git commit --allow-empty --no-verify -m ${'initial subject'} -m ${'initial body line'}`;

      const expectedMessage = 'updated subject\n\nupdated body line 1\nupdated body line 2';
      await configureRewordEditor(tmpDir, expectedMessage);

      const ctx = createGdxContext(tmpDir, ['reword']);
      const result = await reword(ctx);

      expect(result).toBe(0);
      expect(tracker.openedPaths.length).toBe(1);

      const message = await readCommitMessage(tmpDir, 'HEAD');
      expect(message).toBe(expectedMessage);
      expect(buffer.stdout).toContain('@@ -');
      expect(buffer.stdout).toContain('-initial subject');
      expect(buffer.stdout).toContain('+updated subject');

      const rewroteIndex = buffer.stdout.indexOf('Rewrote ');
      const diffIndex = buffer.stdout.indexOf('@@ -');
      expect(diffIndex).toBeGreaterThan(-1);
      expect(rewroteIndex).toBeGreaterThan(diffIndex);
   });

   it('adds wait flag to known fallback editors before opening the message', async () => {
      await resetRepo();

      await $`git commit --allow-empty --no-verify -m ${'fallback editor subject'}`;

      const expectedMessage = 'fallback editor updated subject';
      const editorArgsPath = await configureFakeCodeEditor(tmpDir, expectedMessage);

      const ctx = createGdxContext(tmpDir, ['reword']);
      const result = await reword(ctx);

      expect(result).toBe(0);

      const editorArgs = (await fs.readFile(editorArgsPath, 'utf8')).split('\n');
      expect(editorArgs[0]).toBe('--wait');
      expect(editorArgs[1]).toBe('--reuse-window');

      const message = await readCommitMessage(tmpDir, 'HEAD');
      expect(message).toBe(expectedMessage);
   });

   it('rewords an older commit message exactly and keeps working tree changes', async () => {
      await resetRepo();

      const filePath = path.join(tmpDir, 'note.txt');
      await $`git commit --allow-empty --no-verify -m ${'first subject'} -m ${'first body line'}`;

      await fs.writeFile(filePath, 'alpha');
      await $`git add note.txt`;
      await $`git commit --no-verify -m ${'second subject'} -m ${'second body line'}`;

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

   it('rewords HEAD non-interactively with -m', async () => {
      await resetRepo();

      await $`git commit --allow-empty --no-verify -m ${'old subject'} -m ${'old body'}`;

      const ctx = createGdxContext(tmpDir, [
         'reword',
         '-m',
         'new subject',
         '--message',
         'new body',
      ]);
      const result = await reword(ctx);

      expect(result).toBe(0);
      expect(tracker.openedPaths.length).toBe(0);

      const message = await readCommitMessage(tmpDir, 'HEAD');
      expect(message).toBe('new subject\n\nnew body');
   });

   it('rewords an older commit non-interactively with -m and keeps descendants', async () => {
      await resetRepo();

      await fs.writeFile(path.join(tmpDir, 'older-message.txt'), 'first');
      await $`git add older-message.txt`;
      await $`git commit --no-verify -m ${'first subject'}`;
      await fs.writeFile(path.join(tmpDir, 'newer-message.txt'), 'second');
      await $`git add newer-message.txt`;
      await $`git commit --no-verify -m ${'second subject'}`;

      const ctx = createGdxContext(tmpDir, ['reword', '~1', '-m', 'new first subject']);
      const result = await reword(ctx);

      expect(result).toBe(0);
      expect(tracker.openedPaths.length).toBe(0);

      const olderMessage = await readCommitMessage(tmpDir, 'HEAD~1');
      const latestMessage = await readCommitMessage(tmpDir, 'HEAD');
      expect(olderMessage).toBe('new first subject');
      expect(latestMessage).toBe('second subject');
   });

   it('regenerates and applies a message with auto --yes without opening an editor', async () => {
      await resetRepo();
      resetConfig();
      const config = await getConfig();
      await config.set('commit.commitPattern', 'comprehensive');
      await config.save();

      await fs.writeFile(path.join(tmpDir, 'auto-reword.txt'), 'before');
      await $`git add auto-reword.txt`;
      await $`git commit --no-verify -m ${'old auto subject'}`;
      await fs.writeFile(path.join(tmpDir, 'auto-reword.txt'), 'after');
      await $`git add auto-reword.txt`;
      await $`git commit --no-verify -m ${'message to replace'}`;

      const ctx = createGdxContext(tmpDir, ['reword', 'auto', '--yes']);
      const result = await reword(ctx);

      expect(result).toBe(0);
      expect(tracker.openedPaths.length).toBe(0);

      const message = await readCommitMessage(tmpDir, 'HEAD');
      expect(message).toContain('Mock response from LLM');
      expect(buffer.stdout).toContain('Generated Commit Message');
   });
});
