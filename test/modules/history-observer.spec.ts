import { describe, expect } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import { execa } from 'execa';

import { dispatch } from '@/cli/dispatch';
import history from '@/commands/history';
import {
   defaultHistoryObserverCommand,
   getHistoryObserverHookStatus,
   installHistoryObserverHook,
   readHistoryObserverSpool,
   uninstallHistoryObserverHook,
} from '@/modules/history/observer';
import {
   listHistoryTransactions,
   readHistoryTimeline,
   resolveHistoryStoragePaths,
} from '@/modules/history/storage';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';

describe('history reference-transaction observer', async () => {
   const { tmpDir, $, it, resetRepo } = await createTestEnv({ suitName: 'history-observer' });
   const ctx = createGdxContext(tmpDir);
   const observerCommand = [
      process.execPath,
      path.resolve('src/index.ts'),
      'history',
      '__hook-entry',
   ];

   async function reset(): Promise<void> {
      await resetRepo('full');
   }

   it('pins the default hook command to the current runtime or binary', () => {
      expect(defaultHistoryObserverCommand(['gdx.exe', '-C', tmpDir])).toEqual([
         process.execPath,
         'history',
         '__hook-entry',
      ]);
      expect(defaultHistoryObserverCommand(['bun.exe', 'src/index.ts', '-C', tmpDir])).toEqual([
         process.execPath,
         path.resolve('src/index.ts'),
         'history',
         '__hook-entry',
      ]);
      expect(defaultHistoryObserverCommand(['node.exe', 'scripts/launcher.cjs', '-C', tmpDir])).toEqual([
         process.execPath,
         path.resolve('scripts/launcher.cjs'),
         'history',
         '__hook-entry',
      ]);
   });

   it('preserves and restores an existing hook byte-for-byte', async () => {
      await reset();
      const paths = await resolveHistoryStoragePaths(ctx.git$);
      const hook = path.join(paths.commonGitDir, 'hooks', 'reference-transaction');
      const original = Buffer.from('#!/bin/sh\nprintf original >/dev/null\n', 'utf8');
      await fs.mkdir(path.dirname(hook), { recursive: true });
      await fs.writeFile(hook, original, { mode: 0o755 });

      expect((await installHistoryObserverHook(ctx, { observerCommand })).state).toBe('installed');
      expect((await fs.readFile(hook, 'utf8'))).toContain('gdx-history-reference-transaction-v1');
      expect((await uninstallHistoryObserverHook(ctx)).state).toBe('not-installed');
      expect(await fs.readFile(hook)).toEqual(original);
   });

   it('makes no hook or history changes when Git lacks reference-transaction support', async () => {
      await reset();
      const paths = await resolveHistoryStoragePaths(ctx.git$);
      const fakeGit = path.join(tmpDir, 'fake-old-git.js');
      await fs.writeFile(fakeGit, "console.log('git version 2.28.0')\n");
      const oldCtx = { ...ctx, git$: [process.execPath, fakeGit] };

      await expect(installHistoryObserverHook(oldCtx, { observerCommand })).rejects.toThrow(
         'does not support'
      );
      expect(
         await fs.stat(paths.historyDir).then(() => true).catch(() => false)
      ).toBeFalse();
      expect(
         await fs
            .stat(path.join(paths.commonGitDir, 'hooks', 'reference-transaction'))
            .then(() => true)
            .catch(() => false)
      ).toBeFalse();
   });

   it('imports one direct atomic ref batch and avoids duplicate routed events', async () => {
      await reset();
      await installHistoryObserverHook(ctx, { observerCommand });

      const gitCommand = Array.isArray(ctx.git$) ? ctx.git$ : [ctx.git$];
      await execa(gitCommand[0], [...gitCommand.slice(1), 'branch', 'direct-observed', 'HEAD'], {
         env: { GDX_HISTORY_GUARD: undefined },
      });
      const pending = await readHistoryObserverSpool(ctx);
      expect(pending).toHaveLength(1);
      expect(pending[0].source).toBe('git-hook');
      expect(pending[0].capability).toBe('exact');

      expect(await history(createGdxContext(tmpDir, ['history', 'list']))).toBe(0);
      expect((await readHistoryTimeline(ctx.git$)).entries).toHaveLength(1);
      expect(await readHistoryObserverSpool(ctx)).toHaveLength(0);

      expect(await dispatch(createGdxContext(tmpDir, ['branch', 'routed-once']))).toBe(0);
      expect((await readHistoryTimeline(ctx.git$)).entries).toHaveLength(2);
      expect(await readHistoryObserverSpool(ctx)).toHaveLength(0);
   });

   it('reconciles newer reflog entries only when history is directly invoked', async () => {
      await reset();
      expect(await history(createGdxContext(tmpDir, ['history', 'list']))).toBe(0);
      const gitCommand = Array.isArray(ctx.git$) ? ctx.git$ : [ctx.git$];
      await execa(gitCommand[0], [...gitCommand.slice(1), 'branch', 'reflog-observed', 'HEAD'], {
         env: { GDX_HISTORY_GUARD: undefined },
      });
      expect((await readHistoryTimeline(ctx.git$)).entries).toHaveLength(0);

      expect(await history(createGdxContext(tmpDir, ['history', 'list']))).toBe(0);
      const manifests = await listHistoryTransactions(ctx.git$);
      expect(manifests).toHaveLength(1);
      expect(manifests[0].source).toBe('reflog');
      expect(manifests[0].capability).toBe('inferred');
      expect(manifests[0].paths).toBeUndefined();
      expect(manifests[0].index).toBeUndefined();
   });

   it('refuses custom hooksPath without modifying it', async () => {
      await reset();
      const custom = path.join(tmpDir, 'custom-hooks');
      await fs.mkdir(custom, { recursive: true });
      await $`${ctx.git$} config core.hooksPath ${custom}`;

      await expect(installHistoryObserverHook(ctx, { observerCommand })).rejects.toThrow(
         'Manually chain'
      );
      expect(await fs.readdir(custom)).toEqual([]);
      expect((await getHistoryObserverHookStatus(ctx)).state).toBe('custom-hooks-path');
   });

   it('refuses to remove an externally modified managed hook', async () => {
      await reset();
      const status = await installHistoryObserverHook(ctx, { observerCommand });
      await fs.appendFile(status.hookPath!, '# modified\n');

      await expect(uninstallHistoryObserverHook(ctx)).rejects.toThrow('externally modified');
      expect((await getHistoryObserverHookStatus(ctx)).state).toBe('modified');
   });
});
