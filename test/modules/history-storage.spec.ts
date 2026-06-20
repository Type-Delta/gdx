import { describe, expect } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';

import {
   discardHistoryRedoTail,
   enqueueHistoryObserverEvent,
   initializeHistoryStorage,
   listHistoryObserverEvents,
   readHistoryObserverMetadata,
   readHistoryRepositoryState,
   readHistoryTimeline,
   readHistoryTransactionManifest,
   recordHistoryTransaction,
   removeHistoryObserverEvent,
   resolveHistorySelector,
   resolveHistoryStoragePaths,
   setHistoryCursor,
} from '@/modules/history/storage';
import {
   HISTORY_SCHEMA_VERSION,
   HistoryFingerprint,
   HistoryRepositoryFingerprint,
   HistoryTransactionInput,
} from '@/modules/history/types';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';

describe('history storage', async () => {
   const { tmpDir, tmpRootDir, $, it } = await createTestEnv({ suitName: 'history-storage' });
   const git$ = createGdxContext(tmpDir).git$;

   /** Removes only journal state so each serial test starts with an empty history. */
   async function resetHistory(): Promise<void> {
      const paths = await resolveHistoryStoragePaths(git$);
      await fs.rm(paths.historyDir, { recursive: true, force: true });
   }

   /** Creates a valid fingerprint with a recognizable value. */
   function fingerprint(value: string): HistoryFingerprint {
      return { algorithm: 'sha256', value };
   }

   /** Creates all repository-surface fingerprints for one boundary. */
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

   /** Creates a minimal strict transaction using the persisted product literals. */
   function transaction(id: string, marker = id): HistoryTransactionInput {
      return {
         id,
         source: 'gdx',
         capability: 'exact',
         refs: [
            {
               name: 'refs/heads/main',
               before: { kind: 'missing' },
               after: { kind: 'oid', oid: marker.padEnd(40, '0').slice(0, 40) },
            },
         ],
         fingerprints: {
            before: repositoryFingerprint(`${marker}-before`),
            after: repositoryFingerprint(`${marker}-after`),
         },
      };
   }

   it('resolves repository-local paths without touching storage', async () => {
      await resetHistory();

      const first = await resolveHistoryStoragePaths(git$);
      const second = await resolveHistoryStoragePaths(git$);

      expect(first.historyDir).toBe(path.join(first.commonGitDir, 'gdx', 'history'));
      expect(first.gitDir).toBeTruthy();
      expect(first.root).toBe(await fs.realpath(tmpDir));
      expect(first.id).toBe(second.id);
      expect(first.id).toMatch(/^wt_[a-f0-9]{24}$/);
      expect(
         await fs
            .stat(first.historyDir)
            .then(() => true)
            .catch(() => false)
      ).toBe(false);
   });

   it('initializes versioned state and a per-worktree timeline', async () => {
      await resetHistory();

      const initialized = await initializeHistoryStorage(git$);
      const state = await readHistoryRepositoryState(git$);
      const timeline = await readHistoryTimeline(git$);

      expect(initialized.state.schemaVersion).toBe(HISTORY_SCHEMA_VERSION);
      expect(initialized.state.storageVersion).toBe(1);
      expect(state?.worktrees[initialized.paths.id]?.gitDir).toBe(initialized.paths.gitDir);
      expect(timeline).toMatchObject({
         schemaVersion: HISTORY_SCHEMA_VERSION,
         worktreeId: initialized.paths.id,
         entries: [],
         cursor: 0,
      });
   });

   it('persists literal source/capability and lossless restoration recipes', async () => {
      await resetHistory();
      const rawBlob = {
         path: 'artifacts/index.raw',
         size: 128,
         fingerprint: fingerprint('raw-index'),
      };
      const input: HistoryTransactionInput = {
         id: 'tx_contract',
         source: 'git-hook',
         capability: 'conditional',
         undoUnavailableReason: 'Untracked content must remain unchanged.',
         refs: [
            {
               name: 'HEAD',
               before: { kind: 'symbolic', target: 'refs/heads/main', oid: null },
               after: { kind: 'missing' },
            },
         ],
         head: {
            before: {
               value: { kind: 'symbolic', target: 'refs/heads/main', oid: null },
               unborn: true,
            },
            after: { value: { kind: 'oid', oid: '1'.repeat(40) }, unborn: false },
         },
         index: {
            before: { treeOid: null, entryCount: 1, fingerprint: fingerprint('index-before') },
            after: {
               treeOid: '2'.repeat(40),
               entryCount: 2,
               fingerprint: fingerprint('index-after'),
            },
            undo: { kind: 'tree', treeOid: '3'.repeat(40) },
            redo: {
               kind: 'raw',
               blob: rawBlob,
               checksum: 'raw-checksum',
            },
         },
         paths: [
            {
               path: {
                  bytesBase64: Buffer.from('odd path.txt').toString('base64'),
                  display: 'odd path.txt',
                  tracked: true,
               },
               kind: 'modify',
               before: {
                  kind: 'file',
                  mode: '100644',
                  size: 1,
                  oid: '5'.repeat(40),
                  fingerprint: fingerprint('path-before'),
               },
               after: {
                  kind: 'file',
                  mode: '100644',
                  size: 2,
                  oid: '6'.repeat(40),
                  fingerprint: fingerprint('path-after'),
               },
               staged: true,
            },
         ],
         fingerprints: {
            before: repositoryFingerprint('contract-before'),
            after: repositoryFingerprint('contract-after'),
         },
      };

      await recordHistoryTransaction(git$, input);
      const persisted = await readHistoryTransactionManifest(git$, 'tx_contract');

      expect(persisted).toMatchObject({
         source: 'git-hook',
         capability: 'conditional',
         undoUnavailableReason: 'Untracked content must remain unchanged.',
         index: {
            undo: { kind: 'tree', treeOid: '3'.repeat(40) },
            redo: { kind: 'raw', checksum: 'raw-checksum' },
         },
         paths: [{ path: { display: 'odd path.txt', tracked: true } }],
      });
   });

   it('resolves selectors and discards redo before appending', async () => {
      await resetHistory();
      await recordHistoryTransaction(git$, transaction('tx_first'));
      await recordHistoryTransaction(git$, transaction('tx_second'));
      await recordHistoryTransaction(git$, transaction('tx_third'));

      expect(await resolveHistorySelector(git$, '~0')).toMatchObject({
         id: 'tx_third',
         index: 2,
         relativeIndex: 0,
         state: 'applied',
      });
      expect((await resolveHistorySelector(git$, '~1')).id).toBe('tx_second');
      expect((await resolveHistorySelector(git$, 'tx_f')).id).toBe('tx_first');
      await expect(resolveHistorySelector(git$, 'tx_')).rejects.toThrow('Ambiguous');

      await setHistoryCursor(git$, 1);
      expect((await resolveHistorySelector(git$, '~0', { scope: 'redo' })).id).toBe('tx_second');
      const appended = await recordHistoryTransaction(git$, transaction('tx_replacement'));

      expect(appended.discardedRedoIds).toEqual(['tx_second', 'tx_third']);
      expect(appended.timeline.entries).toEqual(['tx_first', 'tx_replacement']);
      expect(appended.timeline.cursor).toBe(2);
      expect(await readHistoryTransactionManifest(git$, 'tx_second')).toBeNull();
      expect(await readHistoryTransactionManifest(git$, 'tx_third')).toBeNull();
   });

   it('prunes oldest entries and keeps the cursor valid', async () => {
      await resetHistory();
      await recordHistoryTransaction(git$, transaction('tx_one'), { maxEntries: 2 });
      await recordHistoryTransaction(git$, transaction('tx_two'), { maxEntries: 2 });
      const result = await recordHistoryTransaction(git$, transaction('tx_three'), {
         maxEntries: 2,
      });

      expect(result.prunedIds).toEqual(['tx_one']);
      expect(result.timeline.entries).toEqual(['tx_two', 'tx_three']);
      expect(result.timeline.cursor).toBe(2);
      expect(await readHistoryTransactionManifest(git$, 'tx_one')).toBeNull();

      await setHistoryCursor(git$, 1);
      const discarded = await discardHistoryRedoTail(git$);
      expect(discarded.discardedIds).toEqual(['tx_three']);
      expect(discarded.timeline).toMatchObject({ entries: ['tx_two'], cursor: 1 });
   });

   it('serializes concurrent writers without losing transactions', async () => {
      await resetHistory();
      const ids = Array.from({ length: 12 }, (_, index) => `tx_parallel_${index}`);

      await Promise.all(ids.map((id) => recordHistoryTransaction(git$, transaction(id))));

      const timeline = await readHistoryTimeline(git$);
      expect(timeline.entries).toHaveLength(ids.length);
      expect(new Set(timeline.entries)).toEqual(new Set(ids));
      expect(timeline.cursor).toBe(ids.length);

      const paths = await resolveHistoryStoragePaths(git$);
      const temporaryFiles = (await fs.readdir(paths.transactionsDir)).filter((name) =>
         name.endsWith('.tmp')
      );
      expect(temporaryFiles).toEqual([]);
      expect(
         await fs
            .stat(paths.lockFile)
            .then(() => true)
            .catch(() => false)
      ).toBe(false);
   });

   it(
      'shares repository state while isolating linked-worktree timelines',
      async () => {
         await resetHistory();
         const linkedRoot = path.join(tmpRootDir, 'linked-history-worktree');
         await $`git worktree add --detach ${linkedRoot} HEAD`;
         const linkedGit$ = createGdxContext(linkedRoot).git$;

         try {
            const main = await initializeHistoryStorage(git$);
            const linked = await initializeHistoryStorage(linkedGit$);
            await recordHistoryTransaction(git$, transaction('tx_main'));
            await recordHistoryTransaction(linkedGit$, transaction('tx_linked'));

            expect(main.paths.commonGitDir).toBe(linked.paths.commonGitDir);
            expect(main.paths.id).not.toBe(linked.paths.id);
            expect((await readHistoryTimeline(git$)).entries).toEqual(['tx_main']);
            expect((await readHistoryTimeline(linkedGit$)).entries).toEqual(['tx_linked']);
            expect(
               Object.keys((await readHistoryRepositoryState(git$))?.worktrees ?? {})
            ).toHaveLength(2);
         } finally {
            await $`git worktree remove --force ${linkedRoot}`;
         }
      },
      { timeout: 20_000 }
   );

   it('persists observer metadata and ordered spool events', async () => {
      await resetHistory();
      const source = {
         command: 'git status',
         argv: ['status'],
         cwd: tmpDir,
         startedAt: '2026-06-20T00:00:00.000Z',
         finishedAt: '2026-06-20T00:00:00.001Z',
         exitCode: 0,
      };

      const first = await enqueueHistoryObserverEvent(git$, {
         id: 'event_first',
         event: 'command-finish',
         source: 'git-hook',
         command: source,
         before: null,
         after: repositoryFingerprint('first'),
         transactionId: null,
      });
      const second = await enqueueHistoryObserverEvent(git$, {
         id: 'event_second',
         event: 'repository-change',
         source: 'reflog',
         before: repositoryFingerprint('first'),
         after: repositoryFingerprint('second'),
         transactionId: 'tx_observed',
      });

      expect([first.sequence, second.sequence]).toEqual([0, 1]);
      expect((await listHistoryObserverEvents(git$)).map((entry) => entry.id)).toEqual([
         'event_first',
         'event_second',
      ]);
      expect(await readHistoryObserverMetadata(git$)).toMatchObject({
         nextSequence: 2,
         lastTransactionId: 'tx_observed',
      });

      await removeHistoryObserverEvent(git$, 'event_first');
      expect((await listHistoryObserverEvents(git$)).map((entry) => entry.id)).toEqual([
         'event_second',
      ]);
   });

   it('rejects incompatible persisted schema state', async () => {
      await resetHistory();
      const { paths } = await initializeHistoryStorage(git$);
      const state = JSON.parse(await fs.readFile(paths.stateFile, 'utf8')) as Record<
         string,
         unknown
      >;
      state.schemaVersion = 999;
      await fs.writeFile(paths.stateFile, JSON.stringify(state));

      await expect(readHistoryRepositoryState(git$)).rejects.toThrow('Unsupported history schema');
   });
});
