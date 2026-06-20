import { describe, expect } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import { execa } from 'execa';

import { dispatch } from '@/cli/dispatch';
import history from '@/commands/history';
import {
   getHistoryObserverHookStatus,
   installHistoryObserverHook,
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
   const gitCommand = Array.isArray(ctx.git$) ? ctx.git$ : [ctx.git$];
   const shell =
      process.platform === 'win32'
         ? path.resolve(path.dirname(gitCommand[0]), '..', 'bin', 'sh.exe')
         : 'sh';

   async function reset(): Promise<void> {
      await resetRepo('full');
   }

   it('preserves and restores an existing hook byte-for-byte', async () => {
      await reset();
      const paths = await resolveHistoryStoragePaths(ctx.git$);
      const hook = path.join(paths.commonGitDir, 'hooks', 'reference-transaction');
      const original = Buffer.from(
         '#!/bin/sh\nprintf \'%s\\n\' "$1" >>chained-phases\ncat >>chained-input\n',
         'utf8'
      );
      await fs.mkdir(path.dirname(hook), { recursive: true });
      await fs.writeFile(hook, original, { mode: 0o755 });
      await fs.chmod(hook, 0o755);

      expect((await installHistoryObserverHook(ctx)).state).toBe('installed');
      expect((await fs.readFile(hook, 'utf8'))).toContain('gdx-history-reference-transaction-v1');
      await execa(shell, [hook, 'prepared'], { cwd: paths.commonGitDir, input: 'prepared\n' });
      await execa(shell, [hook, 'committed'], { cwd: paths.commonGitDir, input: 'committed\n' });
      expect(await fs.readFile(path.join(paths.commonGitDir, 'chained-phases'), 'utf8')).toBe(
         'prepared\ncommitted\n'
      );
      expect(await fs.readFile(path.join(paths.commonGitDir, 'chained-input'), 'utf8')).toBe(
         'prepared\ncommitted\n'
      );
      expect((await uninstallHistoryObserverHook(ctx)).state).toBe('not-installed');
      expect(await fs.readFile(hook)).toEqual(original);
   });

   it('makes no hook or history changes when Git lacks reference-transaction support', async () => {
      await reset();
      const paths = await resolveHistoryStoragePaths(ctx.git$);
      const fakeGit = path.join(tmpDir, 'fake-old-git.js');
      await fs.writeFile(fakeGit, "console.log('git version 2.28.0')\n");
      const oldCtx = { ...ctx, git$: [process.execPath, fakeGit] };

      await expect(installHistoryObserverHook(oldCtx)).rejects.toThrow('does not support');
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

   it('filters non-committed phases in shell and atomically spools committed stdin', async () => {
      await reset();
      const status = await installHistoryObserverHook(ctx);
      const paths = await resolveHistoryStoragePaths(ctx.git$);
      const spool = path.join(paths.spoolDir, 'reference-transaction-spool');
      const input = `${'0'.repeat(40)} ${'1'.repeat(40)} refs/heads/direct\n`;
      const wrapper = await fs.readFile(status.hookPath!, 'utf8');
      const runPhase = (phase: string) =>
         execa(shell, [status.hookPath!, phase], { input });

      expect(wrapper).not.toContain('__hook-entry');
      expect(wrapper).not.toContain(process.execPath);
      await runPhase('prepared');
      await runPhase('aborted');
      expect(await fs.readdir(spool)).toEqual([]);

      await runPhase('committed');
      const files = await fs.readdir(spool);
      expect(files).toHaveLength(1);
      expect(await fs.readFile(path.join(spool, files[0]), 'utf8')).toBe(input);
   });

   it('imports one direct atomic ref batch and keeps routed Git out of the spool', async () => {
      await reset();
      await installHistoryObserverHook(ctx);

      await execa(gitCommand[0], [...gitCommand.slice(1), 'branch', 'direct-observed', 'HEAD'], {
         env: { GDX_HISTORY_GUARD: undefined },
      });
      const paths = await resolveHistoryStoragePaths(ctx.git$);
      const pending = await fs.readdir(
         path.join(paths.spoolDir, 'reference-transaction-spool')
      );
      expect(pending).toHaveLength(1);
      expect(pending[0]).toEndWith('.raw');
      expect((await readHistoryTimeline(ctx.git$)).entries).toHaveLength(0);

      expect(await history(createGdxContext(tmpDir, ['history', 'list']))).toBe(0);
      expect((await readHistoryTimeline(ctx.git$)).entries).toHaveLength(1);
      expect(
         await fs.readdir(path.join(paths.spoolDir, 'reference-transaction-spool'))
      ).toHaveLength(0);

      expect(await dispatch(createGdxContext(tmpDir, ['branch', 'routed-once']))).toBe(0);
      expect(
         await fs.readdir(path.join(paths.spoolDir, 'reference-transaction-spool'))
      ).toHaveLength(0);
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

      await expect(installHistoryObserverHook(ctx)).rejects.toThrow('Manually chain');
      expect(await fs.readdir(custom)).toEqual([]);
      expect((await getHistoryObserverHookStatus(ctx)).state).toBe('custom-hooks-path');
   });

   it('refuses to remove an externally modified managed hook', async () => {
      await reset();
      const status = await installHistoryObserverHook(ctx);
      await fs.appendFile(status.hookPath!, '# modified\n');

      await expect(uninstallHistoryObserverHook(ctx)).rejects.toThrow('externally modified');
      expect((await getHistoryObserverHookStatus(ctx)).state).toBe('modified');
   });
});
