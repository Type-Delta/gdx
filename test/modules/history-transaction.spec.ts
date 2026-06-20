import { describe, expect } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';

import { dispatch } from '@/cli/dispatch';
import {
   listHistoryTransactions,
   pruneHistory,
   readHistoryTransactionManifest,
   readHistoryTimeline,
   resolveHistoryStoragePaths,
} from '@/modules/history/storage';
import { HistoryDivergenceError, redoHistory, undoHistory } from '@/modules/history/transaction';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';

describe('routed history transactions', async () => {
   const { tmpDir, $, it, resetRepo, buffer } = await createTestEnv({
      suitName: 'history-transaction',
   });
   const ctx = createGdxContext(tmpDir);

   async function reset(): Promise<void> {
      await resetRepo('full');
      const paths = await resolveHistoryStoragePaths(ctx.git$);
      await fs.rm(paths.historyDir, { recursive: true, force: true });
   }

   it('undoes and redoes an index-only add without touching the worktree', async () => {
      await reset();
      const file = path.join(tmpDir, 'added.txt');
      await fs.writeFile(file, 'payload\n');

      expect(await dispatch(createGdxContext(tmpDir, ['add', 'added.txt']))).toBe(0);
      const [manifest] = await listHistoryTransactions(ctx.git$);
      expect(manifest.index).toBeDefined();
      expect(manifest.paths).toBeUndefined();

      expect(await undoHistory(ctx)).toHaveLength(1);
      expect((await $`${ctx.git$} diff --cached --name-only`).stdout.trim()).toBe('');
      expect(await fs.readFile(file, 'utf8')).toBe('payload\n');

      expect(await redoHistory(ctx)).toHaveLength(1);
      expect((await $`${ctx.git$} diff --cached --name-only`).stdout.trim()).toBe('added.txt');
   });

   it('restores commit refs while preserving the exact staged state', async () => {
      await reset();
      await fs.writeFile(path.join(tmpDir, 'commit.txt'), 'committed\n');
      await $`${ctx.git$} add commit.txt`;
      const before = (await $`${ctx.git$} rev-parse HEAD`).stdout.trim();

      expect(
         await dispatch(createGdxContext(tmpDir, ['commit', '--no-verify', '-m', 'history commit']))
      ).toBe(0);
      const after = (await $`${ctx.git$} rev-parse HEAD`).stdout.trim();
      expect(after).not.toBe(before);

      await undoHistory(ctx);
      expect((await $`${ctx.git$} rev-parse HEAD`).stdout.trim()).toBe(before);
      expect((await $`${ctx.git$} diff --cached --name-only`).stdout.trim()).toBe('commit.txt');

      await redoHistory(ctx);
      expect((await $`${ctx.git$} rev-parse HEAD`).stdout.trim()).toBe(after);
      expect((await $`${ctx.git$} status --porcelain`).stdout.trim()).toBe('');
   });

   it('restores dirty tracked preimages across hard reset undo and redo', async () => {
      await reset();
      const file = path.join(tmpDir, 'reset.txt');
      await fs.writeFile(file, 'base\n');
      await $`${ctx.git$} add reset.txt`;
      await $`${ctx.git$} commit --no-verify -m ${'base file'}`;
      const before = (await $`${ctx.git$} rev-parse HEAD`).stdout.trim();
      await fs.writeFile(file, 'dirty\n');

      expect(await dispatch(createGdxContext(tmpDir, ['reset', '--hard', 'HEAD^']))).toBe(0);
      expect(await fs.stat(file).then(() => true).catch(() => false)).toBeFalse();

      await undoHistory(ctx);
      expect((await $`${ctx.git$} rev-parse HEAD`).stdout.trim()).toBe(before);
      expect(await fs.readFile(file, 'utf8')).toBe('dirty\n');

      await redoHistory(ctx);
      expect(await fs.stat(file).then(() => true).catch(() => false)).toBeFalse();
   });

   it('atomically undoes and redoes branch creation', async () => {
      await reset();
      expect(await dispatch(createGdxContext(tmpDir, ['branch', 'history-branch']))).toBe(0);
      expect((await $`${ctx.git$} show-ref --verify refs/heads/history-branch`).exitCode).toBe(0);

      await undoHistory(ctx);
      const missing = await $`${ctx.git$} show-ref --verify refs/heads/history-branch`.catch(
         (error) => error as { exitCode?: number }
      );
      expect(missing.exitCode).not.toBe(0);

      await redoHistory(ctx);
      expect((await $`${ctx.git$} show-ref --verify refs/heads/history-branch`).exitCode).toBe(0);
      expect((await readHistoryTimeline(ctx.git$)).cursor).toBe(1);
   });

   it('refuses divergent refs and leaves the cursor unchanged', async () => {
      await reset();
      await dispatch(createGdxContext(tmpDir, ['branch', 'diverged-branch']));
      await $`${ctx.git$} commit --allow-empty --no-verify -m ${'different target'}`;
      await $`${ctx.git$} branch -f diverged-branch HEAD`;

      await expect(undoHistory(ctx)).rejects.toBeInstanceOf(HistoryDivergenceError);
      expect((await readHistoryTimeline(ctx.git$)).cursor).toBe(1);
   });

   it('adds zero history filesystem work to known read-only commands', async () => {
      await reset();
      const paths = await resolveHistoryStoragePaths(ctx.git$);
      expect(await dispatch(createGdxContext(tmpDir, ['status', '--short']))).toBe(0);
      expect(await fs.stat(paths.historyDir).then(() => true).catch(() => false)).toBeFalse();
   });

   it('records audit-only command/result metadata without an enrichment Git process', async () => {
      await reset();
      buffer.logs = '';
      expect(
         await dispatch(
            createGdxContext(tmpDir, ['config', '--global', 'history-audit.test', 'value'])
         )
      ).toBe(0);
      const auditLogs = buffer.logs;
      const manifests = await listHistoryTransactions(ctx.git$);
      expect(manifests).toHaveLength(1);
      expect(manifests[0].capability).toBe('audit-only');
      expect(manifests[0].refs).toEqual([]);
      expect(manifests[0].undoUnavailableReason).toContain('non-reversible');
      const commands = auditLogs.match(/\$ .*git[^\n]*/g) ?? [];
      expect(commands.filter((line) => line.includes('rev-parse'))).toHaveLength(0);
   });

   it('anchors transaction objects and deletes the capsule during pruning', async () => {
      await reset();
      await fs.writeFile(path.join(tmpDir, 'capsule.txt'), 'capsule\n');
      await dispatch(createGdxContext(tmpDir, ['add', 'capsule.txt']));
      const [manifest] = await listHistoryTransactions(ctx.git$);
      const capsuleRef = `refs/gdx/history/keep/${manifest.id}`;
      expect((await $`${ctx.git$} show-ref --verify ${capsuleRef}`).exitCode).toBe(0);

      await pruneHistory(ctx.git$, 0);
      expect(await readHistoryTransactionManifest(ctx.git$, manifest.id)).toBeNull();
      const missing = await $`${ctx.git$} show-ref --verify ${capsuleRef}`.catch(
         (error) => error as { exitCode?: number }
      );
      expect(missing.exitCode).not.toBe(0);
   });
});
