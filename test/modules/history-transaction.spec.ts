import { describe, expect } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';

import { dispatch } from '@/cli/dispatch';
import {
   listHistoryTransactions,
   readHistoryTimeline,
   resolveHistoryStoragePaths,
} from '@/modules/history/storage';
import { HistoryDivergenceError, redoHistory, undoHistory } from '@/modules/history/transaction';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';

describe('best-effort history transactions', async () => {
   const { tmpDir, $, it, resetRepo } = await createTestEnv({ suitName: 'history-transaction' });
   const ctx = createGdxContext(tmpDir);

   async function reset(): Promise<void> {
      await resetRepo('full');
      const paths = await resolveHistoryStoragePaths(ctx.git$);
      await fs.rm(paths.historyDir, { recursive: true, force: true });
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
      const before = (await $`${ctx.git$} rev-parse HEAD`).stdout.trim();
      await dispatch(createGdxContext(tmpDir, ['commit', '--no-verify', '-m', 'history commit']));
      const after = (await $`${ctx.git$} rev-parse HEAD`).stdout.trim();

      await undoHistory(ctx);
      expect((await $`${ctx.git$} rev-parse HEAD`).stdout.trim()).toBe(before);
      expect((await $`${ctx.git$} diff --cached --name-only`).stdout.trim()).toBe('commit.txt');
      await redoHistory(ctx);
      expect((await $`${ctx.git$} rev-parse HEAD`).stdout.trim()).toBe(after);
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

   it('does not create capsule refs', async () => {
      await reset();
      await fs.writeFile(path.join(tmpDir, 'plain.txt'), 'plain\n');
      await dispatch(createGdxContext(tmpDir, ['add', 'plain.txt']));
      expect((await $`${ctx.git$} for-each-ref --format=${'%(refname)'} refs/gdx/history/keep`).stdout.trim()).toBe('');
   });
});
