import { describe, expect } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';

import { dispatch } from '@/cli/dispatch';
import {
   listHistoryTransactions,
   pruneHistory,
   readHistoryTimeline,
   readHistoryTransactionManifest,
   resolveHistoryStoragePaths,
} from '@/modules/history/storage';
import {
   beginHistoryTransaction,
   discardUnreachableHistory,
   finalizeHistoryTransaction,
   HistoryDivergenceError,
   redoHistory,
   undoHistory,
} from '@/modules/history/transaction';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';

describe('best-effort history transactions', async () => {
   const { tmpDir, tmpRootDir, $, buffer, it, resetRepo } = await createTestEnv({
      suitName: 'history-transaction',
   });
   const ctx = createGdxContext(tmpDir);

   /** Captures the Git and tracked-file state relevant to a history assertion. */
   async function snapshot(files: string[]) {
      const branch = (await $`${ctx.git$} branch --show-current`).stdout.trim();
      const contents = Object.fromEntries(
         await Promise.all(
            files.map(async (file) => {
               try {
                  return [file, await fs.readFile(path.join(tmpDir, file), 'utf8')] as const;
               } catch {
                  return [file, null] as const;
               }
            })
         )
      );
      return {
         branch,
         head: (await $`${ctx.git$} rev-parse HEAD`).stdout.trim(),
         branchRef: (await $`${ctx.git$} rev-parse refs/heads/${branch}`).stdout.trim(),
         status: (await $`${ctx.git$} status --porcelain=v1`).stdout,
         index: (await $`${ctx.git$} ls-files --stage -- ${files}`).stdout,
         stagedDiff: (await $`${ctx.git$} diff --cached --binary -- ${files}`).stdout,
         worktreeDiff: (await $`${ctx.git$} diff --binary -- ${files}`).stdout,
         contents,
      };
   }

   async function reset(): Promise<void> {
      await resetRepo('full');
      const paths = await resolveHistoryStoragePaths(ctx.git$);
      await fs.rm(paths.historyDir, { recursive: true, force: true });
   }

   /** Creates a Git wrapper that fails only private anchor cleanup updates. */
   async function createUpdateRefFailingGit(): Promise<string[]> {
      const realGit = Array.isArray(ctx.git$) ? ctx.git$[0] : ctx.git$;
      const wrapper = path.join(tmpRootDir, 'git-fail-update-ref.cjs');
      await fs.writeFile(
         wrapper,
         `const { spawnSync } = require('node:child_process');\n` +
         `const realGit = ${JSON.stringify(realGit)};\n` +
         `const args = process.argv.slice(2);\n` +
         `if (args.includes('update-ref')) process.exit(73);\n` +
         `const result = spawnSync(realGit, args, { stdio: 'inherit' });\n` +
         `process.exit(result.status ?? 1);\n`,
         'utf8'
      );
      return [process.execPath, wrapper, '-C', tmpDir];
   }

   /** Creates a Git wrapper that permits anchor creation but fails obsolete-anchor deletion. */
   async function createDeleteUpdateRefFailingGit(): Promise<string[]> {
      const realGit = Array.isArray(ctx.git$) ? ctx.git$[0] : ctx.git$;
      const wrapper = path.join(tmpRootDir, 'git-fail-delete-update-ref.cjs');
      await fs.writeFile(
         wrapper,
         `const { spawnSync } = require('node:child_process');\n` +
         `const fs = require('node:fs');\n` +
         `const realGit = ${JSON.stringify(realGit)};\n` +
         `const args = process.argv.slice(2);\n` +
         `if (args.includes('update-ref')) {\n` +
         `  const input = fs.readFileSync(0, 'utf8');\n` +
         `  if (input.includes('delete refs/gdx/history/snapshots/')) process.exit(73);\n` +
         `  const result = spawnSync(realGit, args, { input, stdio: ['pipe', 'inherit', 'inherit'] });\n` +
         `  process.exit(result.status ?? 1);\n` +
         `}\n` +
         `const result = spawnSync(realGit, args, { stdio: 'inherit' });\n` +
         `process.exit(result.status ?? 1);\n`,
         'utf8'
      );
      return [process.execPath, wrapper, '-C', tmpDir];
   }

   /** Creates one recorded snapshot transaction for cleanup-failure tests. */
   async function createSnapshotCherryTransaction(): Promise<string> {
      const initial = (await $`${ctx.git$} rev-parse HEAD`).stdout.trim();
      await $`${ctx.git$} switch -c cleanup-source`;
      await fs.writeFile(path.join(tmpDir, 'cleanup.txt'), 'cleanup\n');
      await $`${ctx.git$} add cleanup.txt`;
      await $`${ctx.git$} commit --no-verify -m ${'cleanup source'}`;
      const sourceCommit = (await $`${ctx.git$} rev-parse HEAD`).stdout.trim();
      await $`${ctx.git$} switch -c cleanup-target ${initial}`;
      expect(await dispatch(createGdxContext(tmpDir, ['cherry-pick', sourceCommit]))).toBe(0);
      const [manifest] = await listHistoryTransactions(ctx.git$);
      expect(manifest.recipe?.kind).toBe('snapshot');
      return manifest.id;
   }

   it('undoes and redoes add with a raw index recipe only', async () => {
      await reset();
      const file = path.join(tmpDir, 'added.txt');
      await fs.writeFile(file, 'payload\n');
      expect(await dispatch(createGdxContext(tmpDir, ['add', 'added.txt']))).toBe(0);
      const [manifest] = await listHistoryTransactions(ctx.git$);
      expect(manifest.recipe?.kind).toBe('raw-index');
      expect(manifest.paths).toBeUndefined();
      expect(manifest.control).toBeUndefined();

      await undoHistory(ctx);
      expect((await $`${ctx.git$} diff --cached --name-only`).stdout.trim()).toBe('');
      expect(await fs.readFile(file, 'utf8')).toBe('payload\n');
      await redoHistory(ctx);
      expect((await $`${ctx.git$} diff --cached --name-only`).stdout.trim()).toBe('added.txt');
   });

   it('undoes and redoes commit with soft resets', async () => {
      await reset();
      await fs.writeFile(path.join(tmpDir, 'commit.txt'), 'committed\n');
      await $`${ctx.git$} add commit.txt`;
      const beforeState = await snapshot(['commit.txt']);
      const before = (await $`${ctx.git$} rev-parse HEAD`).stdout.trim();
      await dispatch(createGdxContext(tmpDir, ['commit', '--no-verify', '-m', 'history commit']));
      const after = (await $`${ctx.git$} rev-parse HEAD`).stdout.trim();
      const afterState = await snapshot(['commit.txt']);
      expect(afterState.contents['commit.txt']).toBe('committed\n');
      expect(afterState.status).toBe('');

      await undoHistory(ctx);
      const undoneState = await snapshot(['commit.txt']);
      expect(undoneState.head).toBe(before);
      expect(undoneState.branchRef).toBe(before);
      expect(undoneState.contents).toEqual(beforeState.contents);
      expect(undoneState.index).toBe(beforeState.index);
      expect(undoneState.stagedDiff).toBe(beforeState.stagedDiff);
      expect(undoneState.worktreeDiff).toBe(beforeState.worktreeDiff);
      expect((await $`${ctx.git$} diff --cached --name-only`).stdout.trim()).toBe('commit.txt');
      await redoHistory(ctx);
      const redoneState = await snapshot(['commit.txt']);
      expect(redoneState.head).toBe(after);
      expect(redoneState.branchRef).toBe(after);
      expect(redoneState.contents).toEqual(afterState.contents);
      expect(redoneState.index).toBe(afterState.index);
      expect(redoneState.stagedDiff).toBe(afterState.stagedDiff);
      expect(redoneState.worktreeDiff).toBe(afterState.worktreeDiff);
   });

   it('undoes and redoes a routed reword with the exact commit and worktree state', async () => {
      await reset();
      await fs.writeFile(path.join(tmpDir, 'reword.txt'), 'reworded content\n');
      await $`${ctx.git$} add reword.txt`;
      await $`${ctx.git$} commit --no-verify -m ${'before reword'}`;

      const before = await snapshot(['reword.txt']);
      const beforeMessage = (await $`${ctx.git$} log -1 --format=%s`).stdout.trim();
      expect(await dispatch(createGdxContext(tmpDir, ['reword', '-m', 'after reword']))).toBe(0);

      const after = await snapshot(['reword.txt']);
      const afterMessage = (await $`${ctx.git$} log -1 --format=%s`).stdout.trim();
      expect(after.head).not.toBe(before.head);
      expect(after.branchRef).toBe(after.head);
      expect(afterMessage).toBe('after reword');

      await undoHistory(ctx);
      expect(await snapshot(['reword.txt'])).toEqual(before);
      expect((await $`${ctx.git$} log -1 --format=%s`).stdout.trim()).toBe(beforeMessage);

      await redoHistory(ctx);
      expect(await snapshot(['reword.txt'])).toEqual(after);
      expect((await $`${ctx.git$} log -1 --format=%s`).stdout.trim()).toBe(afterMessage);
   });

   it('undoes and redoes a successful rebase with HEAD, branch ref, index, and files', async () => {
      await reset();
      const initial = (await $`${ctx.git$} rev-parse HEAD`).stdout.trim();
      await $`${ctx.git$} switch -c topic`;
      await fs.writeFile(path.join(tmpDir, 'topic.txt'), 'topic change\n');
      await $`${ctx.git$} add topic.txt`;
      await $`${ctx.git$} commit --no-verify -m ${'topic commit'}`;
      const topicBefore = (await $`${ctx.git$} rev-parse HEAD`).stdout.trim();
      await $`${ctx.git$} switch -c base ${initial}`;
      await fs.writeFile(path.join(tmpDir, 'base.txt'), 'base change\n');
      await $`${ctx.git$} add base.txt`;
      await $`${ctx.git$} commit --no-verify -m ${'base commit'}`;
      const baseHead = (await $`${ctx.git$} rev-parse HEAD`).stdout.trim();
      await $`${ctx.git$} switch topic`;

      const before = await snapshot(['base.txt', 'topic.txt']);
      expect(before.head).toBe(topicBefore);
      expect(await dispatch(createGdxContext(tmpDir, ['rebase', 'base']))).toBe(0);

      const after = await snapshot(['base.txt', 'topic.txt']);
      const rebasedHead = after.head;
      expect(rebasedHead).not.toBe(topicBefore);
      expect(rebasedHead).not.toBe(baseHead);
      expect(after.branchRef).toBe(rebasedHead);
      expect(after.contents).toEqual({ 'base.txt': 'base change\n', 'topic.txt': 'topic change\n' });

      await $`${ctx.git$} reflog expire --expire=now --all`;
      await $`${ctx.git$} gc --prune=now`;
      await undoHistory(ctx);
      expect(await snapshot(['base.txt', 'topic.txt'])).toEqual(before);

      await redoHistory(ctx);
      expect(await snapshot(['base.txt', 'topic.txt'])).toEqual(after);
   });

   it('undoes and redoes a successful cherry-pick with exact HEAD/ref and tracked content', async () => {
      await reset();
      const initial = (await $`${ctx.git$} rev-parse HEAD`).stdout.trim();
      await $`${ctx.git$} switch -c source`;
      await fs.writeFile(path.join(tmpDir, 'picked.txt'), 'picked content\n');
      await $`${ctx.git$} add picked.txt`;
      await $`${ctx.git$} commit --no-verify -m ${'source change'}`;
      const sourceCommit = (await $`${ctx.git$} rev-parse HEAD`).stdout.trim();
      await $`${ctx.git$} switch -c target ${initial}`;
      await fs.writeFile(path.join(tmpDir, 'unstaged.txt'), 'local unstaged change\n');

      const before = await snapshot(['picked.txt', 'unstaged.txt']);
      expect(before.contents['picked.txt']).toBeNull();
      expect(await dispatch(createGdxContext(tmpDir, ['cherry-pick', sourceCommit]))).toBe(0);

      const after = await snapshot(['picked.txt', 'unstaged.txt']);
      expect(after.head).not.toBe(before.head);
      expect(after.branchRef).toBe(after.head);
      expect(after.contents['picked.txt']).toBe('picked content\n');
      expect(after.status).toContain('?? unstaged.txt');

      await undoHistory(ctx);
      expect(await snapshot(['picked.txt', 'unstaged.txt'])).toEqual(before);

      await fs.writeFile(path.join(tmpDir, 'picked.txt'), 'untracked collision\n');
      const collisionState = await snapshot(['picked.txt', 'unstaged.txt']);
      const collisionCursor = (await readHistoryTimeline(ctx.git$)).cursor;
      await expect(redoHistory(ctx)).rejects.toThrow();
      expect(await snapshot(['picked.txt', 'unstaged.txt'])).toEqual(collisionState);
      expect((await readHistoryTimeline(ctx.git$)).cursor).toBe(collisionCursor);
      await fs.rm(path.join(tmpDir, 'picked.txt'));

      await redoHistory(ctx);
      expect(await snapshot(['picked.txt', 'unstaged.txt'])).toEqual(after);
   });

   it('refuses snapshot undo after semantic index flags diverge', async () => {
      await reset();
      const initial = (await $`${ctx.git$} rev-parse HEAD`).stdout.trim();
      await $`${ctx.git$} switch -c source`;
      await fs.writeFile(path.join(tmpDir, 'flagged.txt'), 'flagged content\n');
      await $`${ctx.git$} add flagged.txt`;
      await $`${ctx.git$} commit --no-verify -m ${'flagged source'}`;
      const sourceCommit = (await $`${ctx.git$} rev-parse HEAD`).stdout.trim();
      await $`${ctx.git$} switch -c target ${initial}`;
      expect(await dispatch(createGdxContext(tmpDir, ['cherry-pick', sourceCommit]))).toBe(0);

      await $`${ctx.git$} update-index --assume-unchanged flagged.txt`;
      const beforeUndo = await snapshot(['flagged.txt']);
      const beforeIndex = await fs.readFile(path.join(tmpDir, '.git', 'index'));
      const beforeFlag = (await $`${ctx.git$} ls-files -v -- flagged.txt`).stdout;
      const beforeCursor = (await readHistoryTimeline(ctx.git$)).cursor;

      await expect(undoHistory(ctx)).rejects.toBeInstanceOf(HistoryDivergenceError);
      expect(await snapshot(['flagged.txt'])).toEqual(beforeUndo);
      expect(await fs.readFile(path.join(tmpDir, '.git', 'index'))).toEqual(beforeIndex);
      expect((await $`${ctx.git$} ls-files -v -- flagged.txt`).stdout).toBe(beforeFlag);
      expect((await readHistoryTimeline(ctx.git$)).cursor).toBe(beforeCursor);
   });

   it('cleans failed snapshot finalization without leaked anchors or journal artifacts', async () => {
      await reset();
      const initial = (await $`${ctx.git$} rev-parse HEAD`).stdout.trim();
      await $`${ctx.git$} switch -c finalize-source`;
      await fs.writeFile(path.join(tmpDir, 'finalize.txt'), 'finalize\n');
      await $`${ctx.git$} add finalize.txt`;
      await $`${ctx.git$} commit --no-verify -m ${'finalize source'}`;
      const sourceCommit = (await $`${ctx.git$} rev-parse HEAD`).stdout.trim();
      await $`${ctx.git$} switch -c finalize-target ${initial}`;

      const captureCtx = createGdxContext(tmpDir);
      captureCtx.git$ = await createUpdateRefFailingGit();
      const capture = await beginHistoryTransaction(captureCtx, {
         action: 'cherry-pick',
         argv: ['cherry-pick', sourceCommit],
         capture: { kind: 'snapshot' },
      });
      await $`${ctx.git$} cherry-pick ${sourceCommit}`;

      await expect(finalizeHistoryTransaction(capture)).rejects.toThrow();
      const anchorRefs = (
         await $`${ctx.git$} for-each-ref --format=${'%(refname)'} refs/gdx/history/snapshots/${capture.id}`
      ).stdout.trim();
      expect(anchorRefs).toBe('');
      expect(await readHistoryTransactionManifest(ctx.git$, capture.id)).toBeNull();
      const paths = await resolveHistoryStoragePaths(ctx.git$);
      expect(
         await fs
            .stat(path.join(paths.historyDir, 'artifacts', capture.id))
            .then(() => true)
            .catch(() => false)
      ).toBe(false);
   });

   it('retains the journal when snapshot anchor cleanup fails during pruning', async () => {
      await reset();
      const id = await createSnapshotCherryTransaction();
      await fs.writeFile(path.join(tmpDir, 'retained.txt'), 'retained\n');
      await $`${ctx.git$} add retained.txt`;
      expect(await dispatch(createGdxContext(tmpDir, ['commit', '--no-verify', '-m', 'retained commit']))).toBe(0);
      const beforeTimeline = await readHistoryTimeline(ctx.git$);
      const beforeAnchors = (
         await $`${ctx.git$} for-each-ref --format=${'%(refname)'} refs/gdx/history/snapshots/${id}`
      ).stdout.trim();
      expect(beforeAnchors).not.toBe('');

      await expect(pruneHistory(await createUpdateRefFailingGit(), 1)).rejects.toThrow(
         'Failed to remove history snapshot anchors'
      );

      expect(await readHistoryTransactionManifest(ctx.git$, id)).not.toBeNull();
      expect(await readHistoryTimeline(ctx.git$)).toEqual(beforeTimeline);
      expect(
         (
            await $`${ctx.git$} for-each-ref --format=${'%(refname)'} refs/gdx/history/snapshots/${id}`
         ).stdout.trim()
      ).toBe(beforeAnchors);
   });

   it('retains and can undo a new snapshot when obsolete-anchor cleanup fails during recording', async () => {
      await reset();
      const obsoleteId = await createSnapshotCherryTransaction();
      const before = (await $`${ctx.git$} rev-parse HEAD`).stdout.trim();

      await $`${ctx.git$} switch -c cleanup-source-followup`;
      await fs.writeFile(path.join(tmpDir, 'cleanup-followup.txt'), 'followup\n');
      await $`${ctx.git$} add cleanup-followup.txt`;
      await $`${ctx.git$} commit --no-verify -m ${'cleanup followup source'}`;
      const sourceCommit = (await $`${ctx.git$} rev-parse HEAD`).stdout.trim();
      await $`${ctx.git$} switch -c cleanup-target-followup ${before}`;

      const captureCtx = createGdxContext(tmpDir);
      captureCtx.git$ = await createDeleteUpdateRefFailingGit();
      const capture = await beginHistoryTransaction(captureCtx, {
         action: 'cherry-pick',
         argv: ['cherry-pick', sourceCommit],
         capture: { kind: 'snapshot' },
      });
      expect(await dispatch(createGdxContext(tmpDir, ['cherry-pick', sourceCommit]))).toBe(0);
      const after = (await $`${ctx.git$} rev-parse HEAD`).stdout.trim();

      const recorded = await finalizeHistoryTransaction(capture, { maxEntries: 1 });
      expect(recorded).not.toBeNull();
      const newId = recorded!.id!;
      expect(newId).toBeDefined();
      expect(newId).not.toBe(obsoleteId);

      const timeline = await readHistoryTimeline(ctx.git$);
      expect(timeline.entries).toEqual([newId]);
      expect(timeline.cursor).toBe(1);
      const newManifest = await readHistoryTransactionManifest(ctx.git$, newId);
      expect(newManifest?.capability).toBe('exact');
      expect(newManifest?.recipe?.kind).toBe('snapshot');
      expect(
         (
            await $`${ctx.git$} for-each-ref --format=${'%(refname)'} refs/gdx/history/snapshots/${newId}`
         ).stdout.trim()
      ).not.toBe('');
      expect(
         (
            await $`${ctx.git$} for-each-ref --format=${'%(refname)'} refs/gdx/history/snapshots/${obsoleteId}`
         ).stdout.trim()
      ).not.toBe('');

      const manifests = await listHistoryTransactions(ctx.git$);
      expect(manifests.filter((manifest) => manifest.id === newId)).toHaveLength(1);
      expect(manifests.filter((manifest) => manifest.capability === 'audit-only')).toEqual([]);
      expect((await $`${ctx.git$} rev-parse HEAD`).stdout.trim()).toBe(after);

      await undoHistory(ctx);
      expect((await $`${ctx.git$} rev-parse HEAD`).stdout.trim()).toBe(before);
      expect((await readHistoryTimeline(ctx.git$)).cursor).toBe(0);
      await redoHistory(ctx);
      expect((await $`${ctx.git$} rev-parse HEAD`).stdout.trim()).toBe(after);
   });

   it('records failed rebase and cherry-pick attempts as audit-only entries', async () => {
      await reset();
      await fs.writeFile(path.join(tmpDir, 'conflict.txt'), 'base\n');
      await $`${ctx.git$} add conflict.txt`;
      await $`${ctx.git$} commit --no-verify -m ${'conflict base'}`;
      const baseBranch = (await $`${ctx.git$} branch --show-current`).stdout.trim();
      await $`${ctx.git$} switch -c rebase-topic`;
      await fs.writeFile(path.join(tmpDir, 'conflict.txt'), 'topic\n');
      await $`${ctx.git$} add conflict.txt`;
      await $`${ctx.git$} commit --no-verify -m ${'conflict topic'}`;
      await $`${ctx.git$} switch ${baseBranch}`;
      await fs.writeFile(path.join(tmpDir, 'conflict.txt'), 'main\n');
      await $`${ctx.git$} add conflict.txt`;
      await $`${ctx.git$} commit --no-verify -m ${'conflict main'}`;
      await $`${ctx.git$} switch rebase-topic`;

      const rebaseExitCode = await dispatch(createGdxContext(tmpDir, ['rebase', baseBranch]));
      expect(rebaseExitCode).not.toBe(0);
      await $`${ctx.git$} rebase --abort`;
      const [rebaseManifest] = await listHistoryTransactions(ctx.git$);
      expect(rebaseManifest.command?.command).toBe('rebase');
      expect(rebaseManifest.command?.exitCode).toBe(rebaseExitCode);
      expect(rebaseManifest.capability).toBe('audit-only');
      expect(rebaseManifest.recipe).toBeUndefined();

      await reset();
      const initial = (await $`${ctx.git$} rev-parse HEAD`).stdout.trim();
      await $`${ctx.git$} switch -c cherry-source`;
      await fs.writeFile(path.join(tmpDir, 'conflict.txt'), 'source\n');
      await $`${ctx.git$} add conflict.txt`;
      await $`${ctx.git$} commit --no-verify -m ${'conflict source'}`;
      const sourceCommit = (await $`${ctx.git$} rev-parse HEAD`).stdout.trim();
      await $`${ctx.git$} switch -c cherry-target ${initial}`;
      await fs.writeFile(path.join(tmpDir, 'conflict.txt'), 'target\n');
      await $`${ctx.git$} add conflict.txt`;
      await $`${ctx.git$} commit --no-verify -m ${'conflict target'}`;

      const cherryExitCode = await dispatch(createGdxContext(tmpDir, ['cherry-pick', sourceCommit]));
      expect(cherryExitCode).not.toBe(0);
      await $`${ctx.git$} cherry-pick --abort`;
      const [cherryManifest] = await listHistoryTransactions(ctx.git$);
      expect(cherryManifest.command?.command).toBe('cherry-pick');
      expect(cherryManifest.command?.exitCode).toBe(cherryExitCode);
      expect(cherryManifest.capability).toBe('audit-only');
      expect(cherryManifest.recipe).toBeUndefined();
   });

   it('records failed audit-only commands with their exit code', async () => {
      await reset();
      const exitCode = await dispatch(
         createGdxContext(tmpDir, ['checkout', 'history-branch-that-does-not-exist'])
      );
      expect(exitCode).not.toBe(0);
      const [manifest] = await listHistoryTransactions(ctx.git$);
      expect(manifest.capability).toBe('audit-only');
      expect(manifest.command?.exitCode).toBe(exitCode);
   });

   it('skips audit-only history quietly when init runs outside a git repository', async () => {
      const outsideDir = path.join(tmpRootDir, 'outside-init');
      await fs.rm(outsideDir, { recursive: true, force: true });
      await fs.mkdir(outsideDir, { recursive: true });
      const outsideCtx = createGdxContext(outsideDir, ['init']);
      outsideCtx.repository = undefined;

      buffer.stdout = '';
      buffer.stderr = '';
      buffer.logs = '';
      expect(await dispatch(outsideCtx)).toBe(0);
      expect(buffer.logs + buffer.stderr).not.toContain('Could not record audit-only history');
      expect(buffer.logs + buffer.stderr).not.toContain('History capture skipped');
   });

   it('skips reversible history quietly when any command runs outside a git repository', async () => {
      const outsideDir = path.join(tmpRootDir, 'outside-add');
      await fs.rm(outsideDir, { recursive: true, force: true });
      await fs.mkdir(outsideDir, { recursive: true });
      const outsideCtx = createGdxContext(outsideDir, ['add', '.']);
      outsideCtx.repository = undefined;

      buffer.stdout = '';
      buffer.stderr = '';
      buffer.logs = '';
      expect(await dispatch(outsideCtx)).not.toBe(0);
      expect(buffer.logs + buffer.stderr).not.toContain('Could not record audit-only history');
      expect(buffer.logs + buffer.stderr).not.toContain('History capture skipped');
   });

   it('skips audit-only entries while undoing and redoing real transactions', async () => {
      await reset();
      const before = (await $`${ctx.git$} rev-parse HEAD`).stdout.trim();
      await fs.writeFile(path.join(tmpDir, 'skip-audit.txt'), 'skip audit\n');
      await $`${ctx.git$} add skip-audit.txt`;
      await dispatch(createGdxContext(tmpDir, ['commit', '--no-verify', '-m', 'skip audit']));
      const after = (await $`${ctx.git$} rev-parse HEAD`).stdout.trim();
      await dispatch(createGdxContext(tmpDir, ['checkout', 'history-branch-that-does-not-exist']));

      const manifests = await listHistoryTransactions(ctx.git$);
      expect(manifests.map((manifest) => manifest.capability)).toEqual(['exact', 'audit-only']);

      const undone = await undoHistory(ctx);
      expect(undone.map((manifest) => manifest.command?.command)).toEqual(['commit']);
      expect((await readHistoryTimeline(ctx.git$)).cursor).toBe(0);
      expect((await $`${ctx.git$} rev-parse HEAD`).stdout.trim()).toBe(before);

      const redone = await redoHistory(ctx);
      expect(redone.map((manifest) => manifest.command?.command)).toEqual(['commit']);
      expect((await readHistoryTimeline(ctx.git$)).cursor).toBe(2);
      expect((await $`${ctx.git$} rev-parse HEAD`).stdout.trim()).toBe(after);
   });

   it('does not create a transaction when a commit fails without changing HEAD', async () => {
      await reset();
      const exitCode = await dispatch(
         createGdxContext(tmpDir, ['commit', '--no-verify', '-m', 'expected failure'])
      );
      expect(exitCode).not.toBe(0);
      expect(await listHistoryTransactions(ctx.git$)).toEqual([]);
   });

   it('undoes amend and soft reset HEAD moves', async () => {
      await reset();
      await fs.writeFile(path.join(tmpDir, 'amend.txt'), 'one\n');
      await $`${ctx.git$} add amend.txt`;
      await $`${ctx.git$} commit --no-verify -m ${'before amend'}`;
      const beforeAmend = (await $`${ctx.git$} rev-parse HEAD`).stdout.trim();
      await fs.writeFile(path.join(tmpDir, 'amend.txt'), 'two\n');
      await $`${ctx.git$} add amend.txt`;
      await dispatch(createGdxContext(tmpDir, ['commit', '--amend', '--no-edit', '--no-verify']));
      const amended = (await $`${ctx.git$} rev-parse HEAD`).stdout.trim();
      await undoHistory(ctx);
      expect((await $`${ctx.git$} rev-parse HEAD`).stdout.trim()).toBe(beforeAmend);
      await redoHistory(ctx);
      expect((await $`${ctx.git$} rev-parse HEAD`).stdout.trim()).toBe(amended);

      await dispatch(createGdxContext(tmpDir, ['reset', '--soft', `${beforeAmend}`]));
      await undoHistory(ctx);
      expect((await $`${ctx.git$} rev-parse HEAD`).stdout.trim()).toBe(amended);
   });

   it('updates only an identified branch ref', async () => {
      await reset();
      await dispatch(createGdxContext(tmpDir, ['branch', 'history-branch']));
      const [manifest] = await listHistoryTransactions(ctx.git$);
      expect(manifest.refs.map((change) => change.name)).toEqual(['refs/heads/history-branch']);
      await undoHistory(ctx);
      expect((await $({ reject: false })`${ctx.git$} show-ref --verify refs/heads/history-branch`).exitCode).not.toBe(0);
      await redoHistory(ctx);
      expect((await $`${ctx.git$} show-ref --verify refs/heads/history-branch`).exitCode).toBe(0);
   });

   it('undoes and redoes an identified tag ref', async () => {
      await reset();
      await dispatch(createGdxContext(tmpDir, ['tag', 'history-tag']));
      await undoHistory(ctx);
      expect((await $({ reject: false })`${ctx.git$} show-ref --verify refs/tags/history-tag`).exitCode).not.toBe(0);
      await redoHistory(ctx);
      expect((await $`${ctx.git$} show-ref --verify refs/tags/history-tag`).exitCode).toBe(0);
   });

   it('switches branches through normal Git switching', async () => {
      await reset();
      await $`${ctx.git$} branch feature`;
      await dispatch(createGdxContext(tmpDir, ['switch', 'feature']));
      expect((await $`${ctx.git$} branch --show-current`).stdout.trim()).toBe('feature');
      await undoHistory(ctx);
      expect((await $`${ctx.git$} branch --show-current`).stdout.trim()).not.toBe('feature');
      await redoHistory(ctx);
      expect((await $`${ctx.git$} branch --show-current`).stdout.trim()).toBe('feature');
   });

   it('bails on ref divergence without moving the cursor', async () => {
      await reset();
      await dispatch(createGdxContext(tmpDir, ['branch', 'diverged-branch']));
      await $`${ctx.git$} commit --allow-empty --no-verify -m ${'different target'}`;
      await $`${ctx.git$} branch -f diverged-branch HEAD`;
      await expect(undoHistory(ctx)).rejects.toBeInstanceOf(HistoryDivergenceError);
      expect((await readHistoryTimeline(ctx.git$)).cursor).toBe(1);
   });

   it('bails on a missing target object without moving the cursor', async () => {
      await reset();
      const tree = (await $`${ctx.git$} write-tree`).stdout.trim();
      const orphan = (
         await $({ env: { GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com' } })`${ctx.git$} commit-tree ${tree} -m ${'orphan'}`
      ).stdout.trim();
      await dispatch(createGdxContext(tmpDir, ['tag', 'missing-object', orphan]));
      await undoHistory(ctx);
      const paths = await resolveHistoryStoragePaths(ctx.git$);
      await fs.rm(path.join(paths.commonGitDir, 'objects', orphan.slice(0, 2), orphan.slice(2)));

      await expect(redoHistory(ctx)).rejects.toThrow();
      expect((await readHistoryTimeline(ctx.git$)).cursor).toBe(0);
   });

   it('discards only entries whose recorded objects were pruned', async () => {
      await reset();
      const tree = (await $`${ctx.git$} write-tree`).stdout.trim();
      const orphan = (
         await $({ env: { GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com' } })`${ctx.git$} commit-tree ${tree} -m ${'pruned'}`
      ).stdout.trim();
      await dispatch(createGdxContext(tmpDir, ['tag', 'pruned-object', orphan]));
      await dispatch(createGdxContext(tmpDir, ['branch', 'still-reachable']));
      await undoHistory(ctx, { count: 2 });
      const paths = await resolveHistoryStoragePaths(ctx.git$);
      await fs.rm(path.join(paths.commonGitDir, 'objects', orphan.slice(0, 2), orphan.slice(2)));

      expect(await discardUnreachableHistory(ctx)).toHaveLength(1);
      const remaining = await listHistoryTransactions(ctx.git$);
      expect(remaining.map((manifest) => manifest.refs[0]?.name)).toEqual([
         'refs/heads/still-reachable',
      ]);
      expect((await readHistoryTimeline(ctx.git$)).cursor).toBe(0);
      expect(await discardUnreachableHistory(ctx)).toHaveLength(0);
   });

   it('does not create capsule refs', async () => {
      await reset();
      await fs.writeFile(path.join(tmpDir, 'plain.txt'), 'plain\n');
      await dispatch(createGdxContext(tmpDir, ['add', 'plain.txt']));
      expect((await $`${ctx.git$} for-each-ref --format=${'%(refname)'} refs/gdx/history/keep`).stdout.trim()).toBe('');
   });
});
