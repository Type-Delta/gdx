import { describe, expect } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';

import history from '@/commands/history';
import { dispatch } from '@/cli/dispatch';
import { stripAnsiColor } from '@/modules/graphics';
import {
   readHistoryTimeline,
   recordHistoryTransaction,
   resolveHistoryStoragePaths,
} from '@/modules/history/storage';
import {
   HistoryFingerprint,
   HistoryRepositoryFingerprint,
   HistoryTransactionInput,
} from '@/modules/history/types';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';

describe('gdx history command', async () => {
   const { tmpDir, buffer, it } = await createTestEnv({ suitName: 'history-command' });
   const ctx = createGdxContext(tmpDir);

   /** Removes journal state without disturbing the isolated repository itself. */
   async function resetHistory(): Promise<void> {
      const paths = await resolveHistoryStoragePaths(ctx.git$);
      await fs.rm(paths.historyDir, { recursive: true, force: true });
   }

   /** Returns all captured command output for assertions. */
   function output(): string {
      return `${buffer.stdout}\n${buffer.stderr}\n${buffer.logs}`;
   }

   /** Creates a recognizable test fingerprint. */
   function fingerprint(value: string): HistoryFingerprint {
      return { algorithm: 'sha256', value };
   }

   /** Creates all repository boundary fingerprints. */
   function repositoryFingerprint(value: string): HistoryRepositoryFingerprint {
      return {
         refs: fingerprint(`${value}-refs`),
         head: fingerprint(`${value}-head`),
         index: fingerprint(`${value}-index`),
         paths: fingerprint(`${value}-paths`),
         control: fingerprint(`${value}-control`),
         combined: fingerprint(`${value}-combined`),
      };
   }

   /** Builds a minimal valid manifest input for command rendering tests. */
   function transaction(id: string, createdAt: string, command = id): HistoryTransactionInput {
      return {
         id,
         createdAt,
         source: 'gdx',
         capability: 'exact',
         command: {
            command,
            argv: [command],
            cwd: tmpDir,
            startedAt: createdAt,
            finishedAt: createdAt,
            exitCode: 0,
         },
         refs: [],
         fingerprints: {
            before: repositoryFingerprint(`${id}-before`),
            after: repositoryFingerprint(`${id}-after`),
         },
      };
   }

   it('supports the default/list alias, limit parsing, selectors, and show', async () => {
      await resetHistory();
      await recordHistoryTransaction(
         ctx.git$,
         transaction('tx_first', '2026-06-20T01:00:00.000Z', 'first command')
      );
      await recordHistoryTransaction(
         ctx.git$,
         transaction('tx_second', '2026-06-20T02:00:00.000Z', 'second command')
      );
      await recordHistoryTransaction(
         ctx.git$,
         transaction('tx_third', '2026-06-20T03:00:00.000Z', 'third command')
      );

      buffer.stdout = '';
      buffer.stderr = '';
      buffer.logs = '';
      expect(await history(createGdxContext(tmpDir, ['history', '--limit', '2']))).toBe(0);
      expect(output()).toContain('#');
      expect(output()).not.toContain('~0');
      expect(output()).toContain('tx_thir');
      expect(output()).toContain('tx_seco');
      expect(output()).not.toContain('tx_first');

      buffer.stdout = '';
      buffer.stderr = '';
      buffer.logs = '';
      expect(await history(createGdxContext(tmpDir, ['history', 'list', '--limit=1']))).toBe(0);
      expect(output()).toContain('tx_thir');
      expect(output()).not.toContain('tx_seco');

      buffer.stdout = '';
      buffer.stderr = '';
      buffer.logs = '';
      expect(await history(createGdxContext(tmpDir, ['history', 'show', '1']))).toBe(0);
      expect(output()).toContain('ID: tx_second');
      expect(output()).toContain('Index: 1');
      expect(output()).toContain('Command: second command');
   });

   it('leaves audit-only entries unindexed in list and show', async () => {
      await resetHistory();
      await recordHistoryTransaction(
         ctx.git$,
         transaction('tx_first', '2026-06-20T01:00:00.000Z', 'first command')
      );
      const auditOnly = transaction('tx_audit', '2026-06-20T02:00:00.000Z', 'pull');
      auditOnly.capability = 'audit-only';
      auditOnly.undoUnavailableReason = 'Remote action retained for audit.';
      await recordHistoryTransaction(ctx.git$, auditOnly);
      await recordHistoryTransaction(
         ctx.git$,
         transaction('tx_third', '2026-06-20T03:00:00.000Z', 'third command')
      );

      buffer.stdout = '';
      buffer.stderr = '';
      buffer.logs = '';
      expect(await history(createGdxContext(tmpDir, ['history', 'list']))).toBe(0);
      const rows = stripAnsiColor(output())
         .replace(/\r/g, '')
         .split('\n')
         .filter((line) => line.includes('tx_'));
      expect(rows.find((line) => line.includes('tx_thir'))?.trimStart().startsWith('0')).toBe(
         true
      );
      expect(rows.find((line) => line.includes('tx_audi'))?.trimStart().startsWith('-')).toBe(
         true
      );
      expect(rows.find((line) => line.includes('tx_firs'))?.trimStart().startsWith('1')).toBe(
         true
      );

      buffer.stdout = '';
      buffer.stderr = '';
      buffer.logs = '';
      expect(await history(createGdxContext(tmpDir, ['history', 'show', '1']))).toBe(0);
      expect(output()).toContain('ID: tx_first');
      expect(output()).toContain('Index: 1');

      buffer.stdout = '';
      buffer.stderr = '';
      buffer.logs = '';
      expect(await history(createGdxContext(tmpDir, ['history', 'show', 'tx_audit']))).toBe(0);
      expect(output()).toContain('ID: tx_audit');
      expect(output()).toContain('Index: -');
      expect(output()).toContain('Remote action retained for audit.');
   });

   it('rejects malformed undo and redo counts before attempting restoration', async () => {
      await resetHistory();

      expect(await history(createGdxContext(tmpDir, ['history', 'undo', '2x']))).toBe(1);
      expect(output()).toContain('count must be a positive integer');

      buffer.stdout = '';
      buffer.stderr = '';
      buffer.logs = '';
      expect(await history(createGdxContext(tmpDir, ['history', 'redo', '0']))).toBe(1);
      expect(output()).toContain('count must be a positive integer');

      buffer.stdout = '';
      buffer.stderr = '';
      buffer.logs = '';
      expect(await history(createGdxContext(tmpDir, ['history', 'list', '--limit']))).toBe(1);
      expect(output()).toContain('requires a value');
   });

   it('reports observer hook status with an actionable state message', async () => {
      await resetHistory();

      expect(await history(createGdxContext(tmpDir, ['history', 'status']))).toBe(0);
      expect(output()).toContain('Observer: not-installed');
      expect(output()).toContain('not installed');
      expect(output()).toContain('reference-transaction');
   });

   it('reconciles only direct user commands, never the internal hook entry', async () => {
      await resetHistory();
      const paths = await resolveHistoryStoragePaths(ctx.git$);
      const checkpoint = path.join(paths.observersDir, 'reflog-checkpoint.json');

      expect(
         await history(
            createGdxContext(tmpDir, [
               'history',
               '__hook-entry',
               '--observer-dir',
               paths.observersDir,
               'prepared',
            ])
         )
      ).toBe(0);
      await expect(fs.stat(checkpoint)).rejects.toThrow();

      expect(await history(createGdxContext(tmpDir, ['history', 'list']))).toBe(0);
      expect((await fs.stat(checkpoint)).isFile()).toBe(true);
   });

   it('skips audit-only undo entries without failing', async () => {
      await resetHistory();
      const entry = transaction('tx_audit', '2026-06-20T04:00:00.000Z', 'audit only');
      entry.capability = 'audit-only';
      entry.undoUnavailableReason = 'Destructive direct Git operation retained for audit.';
      await recordHistoryTransaction(ctx.git$, entry);

      buffer.stdout = '';
      buffer.stderr = '';
      buffer.logs = '';
      expect(await history(createGdxContext(tmpDir, ['history', 'undo']))).toBe(0);
      expect((await readHistoryTimeline(ctx.git$)).cursor).toBe(0);
      expect(output()).toContain('Nothing to undo.');
      expect(output()).not.toContain('Cannot undo tx_audit');
   });

   it('bails cleanly when undo or redo has no work', async () => {
      await resetHistory();
      buffer.stdout = '';
      buffer.stderr = '';
      buffer.logs = '';

      expect(await history(createGdxContext(tmpDir, ['history', 'undo']))).toBe(0);
      expect(await history(createGdxContext(tmpDir, ['history', 'redo']))).toBe(0);

      expect(output()).toContain('Nothing to undo.');
      expect(output()).toContain('Nothing to redo.');
   });

   it('keeps the redo tail after reconciling a history-generated reflog entry', async () => {
      await fs.writeFile(path.join(tmpDir, 'redo.txt'), 'redo\n');
      await dispatch(createGdxContext(tmpDir, ['add', 'redo.txt']));
      await resetHistory();
      await dispatch(createGdxContext(tmpDir, ['commit', '--no-verify', '-m', 'redo test']));

      expect(await history(createGdxContext(tmpDir, ['history', 'undo']))).toBe(0);
      expect((await readHistoryTimeline(ctx.git$)).cursor).toBe(0);
      expect(await history(createGdxContext(tmpDir, ['history', 'redo']))).toBe(0);
      expect((await readHistoryTimeline(ctx.git$)).cursor).toBe(1);
      expect(output()).toContain('Redid 1 history transaction');
   });
});
