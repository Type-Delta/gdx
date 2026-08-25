import { describe, expect } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import { execa } from 'execa';

import { dispatch } from '@/cli/dispatch';
import history from '@/commands/history';
import {
   getHistoryObserverHookStatus,
   installHistoryObserverHook,
   importHistoryObserverSpool,
   reconcileHistoryReflogs,
   uninstallHistoryObserverHook,
} from '@/modules/history/observer';
import {
   listHistoryTransactions,
   readHistoryTimeline,
   resolveHistoryStoragePaths,
} from '@/modules/history/storage';
import { createGdxContext, createTestEnv, resolvePosixShell } from '@/utils/testHelper';

describe('history reference-transaction observer', async () => {
   const { tmpDir, $, it, resetRepo } = await createTestEnv({ suitName: 'history-observer' });
   const ctx = createGdxContext(tmpDir);
   const gitCommand = Array.isArray(ctx.git$) ? ctx.git$ : [ctx.git$];
   const shell = await resolvePosixShell(gitCommand[0]);

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

   it('imports a direct ref batch and deduplicates a routed hook batch', async () => {
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
      ).toHaveLength(1);

      expect(await history(createGdxContext(tmpDir, ['history', 'list']))).toBe(0);
      expect((await readHistoryTimeline(ctx.git$)).entries).toHaveLength(2);
      expect(
         await fs.readdir(path.join(paths.spoolDir, 'reference-transaction-spool'))
      ).toHaveLength(0);
   });

   it('deduplicates routed hook batches one-to-one without partial-batch matches', async () => {
      await reset();
      const observer = await installHistoryObserverHook(ctx);
      try {
         expect(await dispatch(createGdxContext(tmpDir, ['branch', 'routed-batch']))).toBe(0);
         const paths = await resolveHistoryStoragePaths(ctx.git$);
         const spool = path.join(paths.spoolDir, 'reference-transaction-spool');
         const [originalName] = await fs.readdir(spool);
         const original = path.join(spool, originalName);
         const [input, stat] = await Promise.all([fs.readFile(original), fs.stat(original)]);

         const duplicate = path.join(spool, 'duplicate.raw');
         await fs.copyFile(original, duplicate);
         await fs.utimes(duplicate, stat.atime, stat.mtime);

         const head = (await $`${ctx.git$} rev-parse HEAD`).stdout.trim();
         const partial = path.join(spool, 'partial.raw');
         await fs.writeFile(
            partial,
            Buffer.concat([
               input,
               Buffer.from(`${'0'.repeat(head.length)} ${head} refs/heads/partial-batch\n`),
            ])
         );
         await fs.utimes(partial, stat.atime, stat.mtime);

         expect(await importHistoryObserverSpool(ctx)).toHaveLength(2);
         const manifests = await listHistoryTransactions(ctx.git$);
         expect(manifests.filter((manifest) => manifest.source === 'gdx')).toHaveLength(1);
         expect(manifests.filter((manifest) => manifest.source === 'git-hook')).toHaveLength(2);
         expect(
            manifests.some(
               (manifest) => manifest.source === 'git-hook' && manifest.refs.length === 2
            )
         ).toBeTrue();
         expect(await fs.readdir(spool)).toEqual([]);
      } finally {
         await uninstallHistoryObserverHook(ctx).catch(() => undefined);
      }
   });

   it('deduplicates the HEAD-only hook batch from routed checkout', async () => {
      await reset();
      const observer = await installHistoryObserverHook(ctx);
      try {
         expect(await dispatch(createGdxContext(tmpDir, ['branch', 'observer-checkout']))).toBe(0);
         expect(await dispatch(createGdxContext(tmpDir, ['checkout', 'observer-checkout']))).toBe(0);

         expect(await history(createGdxContext(tmpDir, ['history', 'list']))).toBe(0);
         const manifests = await listHistoryTransactions(ctx.git$);
         expect(
            manifests.filter((manifest) => manifest.command?.command === 'checkout')
         ).toHaveLength(1);
         expect(manifests.filter((manifest) => manifest.source === 'git-hook')).toHaveLength(0);
      } finally {
         await uninstallHistoryObserverHook(ctx).catch(() => undefined);
      }
   });

   it('deduplicates every hook batch from routed branch-creating checkout', async () => {
      await reset();
      const observer = await installHistoryObserverHook(ctx);
      try {
         expect(
            await dispatch(
               createGdxContext(tmpDir, ['checkout', '-b', 'observer-created-checkout'])
            )
         ).toBe(0);

         expect(await history(createGdxContext(tmpDir, ['history', 'list']))).toBe(0);
         const manifests = await listHistoryTransactions(ctx.git$);
         expect(
            manifests.filter((manifest) => manifest.command?.command === 'checkout')
         ).toHaveLength(1);
         expect(manifests.filter((manifest) => manifest.source === 'git-hook')).toHaveLength(0);
      } finally {
         await uninstallHistoryObserverHook(ctx).catch(() => undefined);
      }
   });

   it('deduplicates every hook batch from routed branch-creating switch', async () => {
      await reset();
      const observer = await installHistoryObserverHook(ctx);
      try {
         expect(
            await dispatch(createGdxContext(tmpDir, ['switch', '-c', 'observer-created-switch']))
         ).toBe(0);

         expect(await history(createGdxContext(tmpDir, ['history', 'list']))).toBe(0);
         const manifests = await listHistoryTransactions(ctx.git$);
         expect(
            manifests.filter((manifest) => manifest.command?.command === 'switch')
         ).toHaveLength(1);
         expect(manifests.filter((manifest) => manifest.source === 'git-hook')).toHaveLength(0);
      } finally {
         await uninstallHistoryObserverHook(ctx).catch(() => undefined);
      }
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
      expect(manifests[0].capability).toBe('audit-only');
      expect(manifests[0].undoUnavailableReason).toContain('retained for audit');
      expect(manifests[0].paths).toBeUndefined();
      expect(manifests[0].index).toBeUndefined();
   });

   it('deduplicates one matching reflog movement per routed head transition', async () => {
      await reset();
      expect(await history(createGdxContext(tmpDir, ['history', 'list']))).toBe(0);

      const before = (await $`${ctx.git$} rev-parse HEAD`).stdout.trim();
      const branch = (await $`${ctx.git$} branch --show-current`).stdout.trim();
      const ref = `refs/heads/${branch}`;
      await fs.writeFile(path.join(tmpDir, 'dedupe.txt'), 'dedupe\n');
      await $`${ctx.git$} add dedupe.txt`;
      expect(await dispatch(createGdxContext(tmpDir, ['commit', '--no-verify', '-m', 'dedupe commit']))).toBe(0);
      const after = (await $`${ctx.git$} rev-parse HEAD`).stdout.trim();

      // Each A->B movement below has a B->A reflog transition between it. The
      // routed commit manifest may consume only one matching A->B transition.
      for (let index = 0; index < 2; index++) {
         await $`${ctx.git$} update-ref ${ref} ${before} ${after}`;
         await $`${ctx.git$} update-ref ${ref} ${after} ${before}`;
      }

      expect(await history(createGdxContext(tmpDir, ['history', 'list']))).toBe(0);
      const manifests = await listHistoryTransactions(ctx.git$);
      const routed = manifests.filter((manifest) => manifest.source === 'gdx');
      const matchingReflogs = manifests.filter(
         (manifest) =>
            manifest.source === 'reflog' &&
            manifest.refs.some(
               (change) =>
                  change.name === ref &&
                  change.before.kind === 'oid' &&
                  change.before.oid === before &&
                  change.after.kind === 'oid' &&
                  change.after.oid === after
            )
      );
      expect(routed).toHaveLength(1);
      expect(routed[0].capability).not.toBe('audit-only');
      expect(matchingReflogs).toHaveLength(2);
   });

   it('deduplicates a hook record and blank-message reflog movement one-to-one', async () => {
      await reset();
      expect(await history(createGdxContext(tmpDir, ['history', 'list']))).toBe(0);

      const before = (await $`${ctx.git$} rev-parse HEAD`).stdout.trim();
      const branch = (await $`${ctx.git$} branch --show-current`).stdout.trim();
      const ref = `refs/heads/${branch}`;
      await fs.writeFile(path.join(tmpDir, 'hook-dedupe.txt'), 'hook dedupe\n');
      await $`${ctx.git$} add hook-dedupe.txt`;
      expect(await dispatch(createGdxContext(tmpDir, ['commit', '--no-verify', '-m', 'hook dedupe commit']))).toBe(0);
      const after = (await $`${ctx.git$} rev-parse HEAD`).stdout.trim();

      const observer = await installHistoryObserverHook(ctx);
      try {
         await $`${ctx.git$} update-ref ${ref} ${before} ${after}`;
         await $`${ctx.git$} update-ref ${ref} ${after} ${before}`;
         await execa(shell, [observer.hookPath!, 'committed'], {
            input: `${before} ${after} ${ref}\n`,
         });
         expect(await history(createGdxContext(tmpDir, ['history', 'list']))).toBe(0);

         const manifests = await listHistoryTransactions(ctx.git$);
         const hookMatches = manifests.filter(
            (manifest) =>
               manifest.source === 'git-hook' &&
               manifest.refs.some(
                  (change) =>
                     change.name === ref &&
                     change.before.kind === 'oid' &&
                     change.before.oid === before &&
                     change.after.kind === 'oid' &&
                     change.after.oid === after
               )
         );
         const reflogMatches = manifests.filter(
            (manifest) =>
               manifest.source === 'reflog' &&
               manifest.refs.some(
                  (change) =>
                     change.name === ref &&
                     change.before.kind === 'oid' &&
                     change.before.oid === before &&
                     change.after.kind === 'oid' &&
                     change.after.oid === after
               )
         );
         expect(hookMatches).toHaveLength(1);
         expect(reflogMatches).toHaveLength(0);
      } finally {
         expect((await uninstallHistoryObserverHook(ctx)).hookPath).toBe(observer.hookPath);
      }
   });

   it('imports a later identical reflog movement after an earlier observer record is persisted', async () => {
      await reset();
      expect(await history(createGdxContext(tmpDir, ['history', 'list']))).toBe(0);

      const before = (await $`${ctx.git$} rev-parse HEAD`).stdout.trim();
      const branch = (await $`${ctx.git$} branch --show-current`).stdout.trim();
      const ref = `refs/heads/${branch}`;
      const tree = (await $`${ctx.git$} rev-parse HEAD^{tree}`).stdout.trim();
      const after = (
         await $({
            env: {
               GIT_AUTHOR_NAME: 'observer',
               GIT_AUTHOR_EMAIL: 'observer@example.com',
               GIT_COMMITTER_NAME: 'observer',
               GIT_COMMITTER_EMAIL: 'observer@example.com',
            },
         })`${ctx.git$} commit-tree ${tree} -p ${before} -m ${'observer A to B'}`
      ).stdout.trim();

      await $`${ctx.git$} update-ref ${ref} ${after} ${before}`;
      const firstReconciliation = await reconcileHistoryReflogs(ctx);
      expect(firstReconciliation.imported).toHaveLength(1);
      const firstImport = await importHistoryObserverSpool(ctx);
      expect(firstImport).toHaveLength(1);
      expect(firstImport[0].source).toBe('reflog');

      // Keep all three movements in the same Git timestamp window. The
      // persisted first A->B observer manifest may consume only its own
      // transition; it must not suppress this later, distinct A->B event.
      await $`${ctx.git$} update-ref ${ref} ${before} ${after}`;
      await $`${ctx.git$} update-ref ${ref} ${after} ${before}`;
      const secondReconciliation = await reconcileHistoryReflogs(ctx);
      expect(secondReconciliation.imported).toHaveLength(2);
      const secondImport = await importHistoryObserverSpool(ctx);
      expect(secondImport).toHaveLength(2);

      const matching = [...firstImport, ...secondImport].filter(
         (manifest) =>
            manifest.source === 'reflog' &&
            manifest.refs.some(
               (change) =>
                  change.name === ref &&
                  change.before.kind === 'oid' &&
                  change.before.oid === before &&
                  change.after.kind === 'oid' &&
                  change.after.oid === after
            )
      );
      expect(matching).toHaveLength(2);
      expect(new Set(matching.map((manifest) => manifest.id)).size).toBe(2);
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
