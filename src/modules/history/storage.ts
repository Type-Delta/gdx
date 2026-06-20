import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

import { GdxContext, GdxRepositoryLocation } from '@/common/types';
import { $ } from '@/modules/shell';

import {
   HISTORY_CAPABILITIES,
   HISTORY_SCHEMA_VERSION,
   HISTORY_SOURCES,
   HISTORY_STORAGE_VERSION,
   HistoryObserverMetadata,
   HistoryObserverSpoolEntry,
   HistoryObserverSpoolInput,
   HistoryRecordResult,
   HistoryRepositoryState,
   HistorySelectorScope,
   HistoryStoragePaths,
   HistoryTimeline,
   HistoryTimelineSelection,
   HistoryTransactionId,
   HistoryTransactionInput,
   HistoryTransactionManifest,
   HistoryWorktreeIdentity,
   HistoryWorktreeRegistration,
} from './types';

export const DEFAULT_HISTORY_MAX_ENTRIES = 100;

const HISTORY_DIRECTORY_NAME = 'gdx/history';
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 60_000;
const DEFAULT_LOCK_RETRY_MS = 20;

/** Options for acquiring the repository-wide history lock. */
export interface HistoryLockOptions {
   timeoutMs?: number;
   staleMs?: number;
   retryMs?: number;
}

/** Recording options for bounded history and pre-resolved repository paths. */
export interface HistoryRecordOptions {
   maxEntries?: number;
   /** Pre-resolved startup paths avoid audit-only Git/working-tree inspection. */
   repository?: GdxRepositoryLocation;
}

/** Options for resolving relative timeline selectors. */
export interface HistorySelectorOptions {
   scope?: HistorySelectorScope;
   repository?: GdxRepositoryLocation;
}

/** Error raised for malformed or incompatible persisted history data. */
export class HistoryStorageError extends Error {
   constructor(message: string) {
      super(message);
      this.name = 'HistoryStorageError';
   }
}

/** Error raised when another process holds the history lock too long. */
export class HistoryLockTimeoutError extends HistoryStorageError {
   constructor(lockFile: string) {
      super(`Timed out waiting for history lock: ${lockFile}`);
      this.name = 'HistoryLockTimeoutError';
   }
}

/** Error raised for missing or ambiguous history selectors. */
export class HistorySelectorError extends HistoryStorageError {
   constructor(message: string) {
      super(message);
      this.name = 'HistorySelectorError';
   }
}

/**
 * Resolves repository, common Git, per-worktree Git, and journal paths without
 * creating or reading history storage.
 * @param git$ - Git executable/context from GdxContext.
 * @returns Fully resolved paths and stable worktree identity.
 */
export async function resolveHistoryStoragePaths(
   git$: GdxContext['git$']
): Promise<HistoryStoragePaths> {
   const output = (
      await $`${git$} rev-parse --path-format=absolute --show-toplevel --git-common-dir --git-dir`
   ).stdout
      .split(/\r?\n/)
      .filter(Boolean);
   if (output.length !== 3) {
      throw new HistoryStorageError('Unable to resolve Git worktree directories.');
   }

   const [rootRaw, commonGitDirRaw, gitDirRaw] = output;
   const [root, commonGitDir, gitDir] = await Promise.all([
      canonicalizeDirectory(rootRaw),
      canonicalizeDirectory(commonGitDirRaw),
      canonicalizeDirectory(gitDirRaw),
   ]);
   const id = createWorktreeId(commonGitDir, gitDir);
   const historyDir = path.join(commonGitDir, ...HISTORY_DIRECTORY_NAME.split('/'));
   const timelinesDir = path.join(historyDir, 'timelines');
   const transactionsDir = path.join(historyDir, 'transactions');
   const observersDir = path.join(historyDir, 'observers');
   const spoolDir = path.join(historyDir, 'spool');
   const locksDir = path.join(historyDir, 'locks');

   return {
      id,
      root,
      commonGitDir,
      gitDir,
      historyDir,
      stateFile: path.join(historyDir, 'state.json'),
      timelinesDir,
      timelineFile: path.join(timelinesDir, `${id}.json`),
      transactionsDir,
      observersDir,
      observerMetadataFile: path.join(observersDir, `${id}.json`),
      spoolDir,
      worktreeSpoolDir: path.join(spoolDir, id),
      locksDir,
      lockFile: path.join(locksDir, 'journal.lock'),
   };
}

/** Alias for resolveHistoryStoragePaths. */
export const resolveHistoryPaths = resolveHistoryStoragePaths;

/** Builds journal paths from repository locations already resolved by startup. */
export function createHistoryStoragePaths(
   repository: GdxRepositoryLocation
): HistoryStoragePaths {
   const root = path.resolve(repository.root);
   const commonGitDir = path.resolve(repository.commonGitDir);
   const gitDir = path.resolve(repository.gitDir);
   const id = createWorktreeId(commonGitDir, gitDir);
   const historyDir = path.join(commonGitDir, ...HISTORY_DIRECTORY_NAME.split('/'));
   const timelinesDir = path.join(historyDir, 'timelines');
   const transactionsDir = path.join(historyDir, 'transactions');
   const observersDir = path.join(historyDir, 'observers');
   const spoolDir = path.join(historyDir, 'spool');
   const locksDir = path.join(historyDir, 'locks');
   return {
      id,
      root,
      commonGitDir,
      gitDir,
      historyDir,
      stateFile: path.join(historyDir, 'state.json'),
      timelinesDir,
      timelineFile: path.join(timelinesDir, `${id}.json`),
      transactionsDir,
      observersDir,
      observerMetadataFile: path.join(observersDir, `${id}.json`),
      spoolDir,
      worktreeSpoolDir: path.join(spoolDir, id),
      locksDir,
      lockFile: path.join(locksDir, 'journal.lock'),
   };
}

/**
 * Resolves the stable identity of the current worktree.
 * @param git$ - Git executable/context from GdxContext.
 * @returns Stable worktree identity.
 */
export async function resolveHistoryWorktreeIdentity(
   git$: GdxContext['git$']
): Promise<HistoryWorktreeIdentity> {
   const { id, root, commonGitDir, gitDir } = await resolveHistoryStoragePaths(git$);
   return { id, root, commonGitDir, gitDir };
}

/** Alias for resolveHistoryWorktreeIdentity. */
export const getHistoryWorktreeIdentity = resolveHistoryWorktreeIdentity;

/**
 * Initializes schema state and the current worktree timeline.
 * @param git$ - Git executable/context from GdxContext.
 * @returns Initialized state, timeline, and resolved paths.
 */
export async function initializeHistoryStorage(git$: GdxContext['git$']): Promise<{
   state: HistoryRepositoryState;
   timeline: HistoryTimeline;
   paths: HistoryStoragePaths;
}> {
   const paths = await resolveHistoryStoragePaths(git$);
   return await withResolvedHistoryLock(paths, async () => {
      await ensureHistoryDirectories(paths);
      const now = new Date().toISOString();
      const existingState = await readRepositoryStateFile(paths.stateFile);
      const existingTimeline = await readTimelineFile(paths.timelineFile, paths.id);
      const timeline = existingTimeline ?? createEmptyTimeline(paths.id, now);
      let state = existingState ?? createEmptyRepositoryState(now);
      state = registerWorktree(state, paths, now);

      if (!existingTimeline) await atomicWriteJson(paths.timelineFile, timeline);
      if (!existingState || state !== existingState) await atomicWriteJson(paths.stateFile, state);

      return { state, timeline, paths };
   });
}

/** Alias for initializeHistoryStorage. */
export const ensureHistoryStorage = initializeHistoryStorage;

/**
 * Reads repository-level history state without creating storage.
 * @param git$ - Git executable/context from GdxContext.
 * @returns Persisted state, or null when history has not been initialized.
 */
export async function readHistoryRepositoryState(
   git$: GdxContext['git$'],
   repository?: GdxRepositoryLocation
): Promise<HistoryRepositoryState | null> {
   const paths = repository
      ? createHistoryStoragePaths(repository)
      : await resolveHistoryStoragePaths(git$);
   return await readRepositoryStateFile(paths.stateFile);
}

/** Alias for readHistoryRepositoryState. */
export const readHistoryState = readHistoryRepositoryState;

/**
 * Reads the current worktree timeline without creating storage.
 * @param git$ - Git executable/context from GdxContext.
 * @returns Persisted timeline, or an in-memory empty timeline when absent.
 */
export async function readHistoryTimeline(
   git$: GdxContext['git$'],
   repository?: GdxRepositoryLocation
): Promise<HistoryTimeline> {
   const paths = repository
      ? createHistoryStoragePaths(repository)
      : await resolveHistoryStoragePaths(git$);
   return (
      (await readTimelineFile(paths.timelineFile, paths.id)) ??
      createEmptyTimeline(paths.id, new Date().toISOString())
   );
}

/**
 * Runs a mutation while holding the repository-wide history lock.
 * @param git$ - Git executable/context from GdxContext.
 * @param operation - Mutation to serialize.
 * @param options - Lock timing options.
 * @returns The operation result.
 */
export async function withHistoryStorageLock<T>(
   git$: GdxContext['git$'],
   operation: (paths: HistoryStoragePaths) => Promise<T>,
   options: HistoryLockOptions = {}
): Promise<T> {
   const paths = await resolveHistoryStoragePaths(git$);
   return await withResolvedHistoryLock(paths, () => operation(paths), options);
}

/**
 * Generates a path-safe, process-independent transaction identifier.
 * @returns A stable ID suitable for manifest filenames and selectors.
 */
export function createHistoryTransactionId(): HistoryTransactionId {
   return `tx_${crypto.randomUUID().replaceAll('-', '')}`;
}

/**
 * Records a transaction and discards the redo tail from the active timeline.
 * @param git$ - Git executable/context from GdxContext.
 * @param input - Strict transaction data to persist.
 * @param options - Pre-resolved repository paths and legacy options.
 * @returns Manifest, resulting timeline, and discarded IDs.
 */
export async function recordHistoryTransaction(
   git$: GdxContext['git$'],
   input: HistoryTransactionInput,
   options: HistoryRecordOptions = {}
): Promise<HistoryRecordResult> {
   const maxEntries = normalizeMaxEntries(options.maxEntries);
   const paths = options.repository
      ? createHistoryStoragePaths(options.repository)
      : await resolveHistoryStoragePaths(git$);

   return await withResolvedHistoryLock(paths, async () => {
      await ensureHistoryDirectories(paths);
      const now = input.createdAt ?? new Date().toISOString();
      const id = input.id ?? createHistoryTransactionId();
      assertSafeId(id, 'transaction');
      const manifest: HistoryTransactionManifest = {
         ...input,
         schemaVersion: HISTORY_SCHEMA_VERSION,
         id,
         worktreeId: paths.id,
         createdAt: now,
      };
      assertTransactionManifest(manifest, paths.id);

      const timeline =
         (await readTimelineFile(paths.timelineFile, paths.id)) ??
         createEmptyTimeline(paths.id, now);
      if (timeline.entries.includes(id) || (await pathExists(transactionFile(paths, id)))) {
         throw new HistoryStorageError(`History transaction already exists: ${id}`);
      }

      const discardedRedoIds = timeline.entries.slice(timeline.cursor);
      const retainedApplied = timeline.entries.slice(0, timeline.cursor);
      const appended = [...retainedApplied, id];
      const pruneCount = Math.max(0, appended.length - maxEntries);
      const prunedIds = appended.slice(0, pruneCount);
      const entries = appended.slice(pruneCount);
      const nextTimeline: HistoryTimeline = {
         ...timeline,
         revision: timeline.revision + 1,
         updatedAt: now,
         entries,
         cursor: entries.length,
      };

      await atomicWriteJson(transactionFile(paths, id), manifest);
      await atomicWriteJson(paths.timelineFile, nextTimeline);

      const existingState = await readRepositoryStateFile(paths.stateFile);
      const state = registerWorktree(existingState ?? createEmptyRepositoryState(now), paths, now);
      await atomicWriteJson(paths.stateFile, state);
      await removeTransactionFiles(paths, [...discardedRedoIds, ...prunedIds]);
      return { manifest, timeline: nextTimeline, discardedRedoIds, prunedIds };
   });
}

/** Alias for recordHistoryTransaction. */
export const appendHistoryTransaction = recordHistoryTransaction;

/**
 * Writes a complete manifest without adding it to a timeline.
 * @param git$ - Git executable/context from GdxContext.
 * @param manifest - Complete manifest for the current worktree.
 */
export async function writeHistoryTransactionManifest(
   git$: GdxContext['git$'],
   manifest: HistoryTransactionManifest
): Promise<void> {
   const paths = await resolveHistoryStoragePaths(git$);
   assertTransactionManifest(manifest, paths.id);
   await withResolvedHistoryLock(paths, async () => {
      await ensureHistoryDirectories(paths);
      const filePath = transactionFile(paths, manifest.id);
      if (await pathExists(filePath)) {
         throw new HistoryStorageError(`History transaction already exists: ${manifest.id}`);
      }
      await atomicWriteJson(filePath, manifest);
   });
}

/** Alias for writeHistoryTransactionManifest. */
export const writeHistoryTransaction = writeHistoryTransactionManifest;

/**
 * Reads one transaction manifest by stable ID.
 * @param git$ - Git executable/context from GdxContext.
 * @param id - Exact transaction ID.
 * @returns The manifest, or null when absent.
 */
export async function readHistoryTransactionManifest(
   git$: GdxContext['git$'],
   id: HistoryTransactionId,
   repository?: GdxRepositoryLocation
): Promise<HistoryTransactionManifest | null> {
   assertSafeId(id, 'transaction');
   const paths = repository
      ? createHistoryStoragePaths(repository)
      : await resolveHistoryStoragePaths(git$);
   const manifest = await readJsonFile<HistoryTransactionManifest>(transactionFile(paths, id));
   if (!manifest) return null;
   assertTransactionManifest(manifest, paths.id);
   return manifest;
}

/** Alias for readHistoryTransactionManifest. */
export const readHistoryTransaction = readHistoryTransactionManifest;

/**
 * Lists manifests in timeline order.
 * @param git$ - Git executable/context from GdxContext.
 * @returns Existing transaction manifests from oldest to newest.
 */
export async function listHistoryTransactions(
   git$: GdxContext['git$'],
   repository?: GdxRepositoryLocation
): Promise<HistoryTransactionManifest[]> {
   const timeline = await readHistoryTimeline(git$, repository);
   const manifests = await Promise.all(
      timeline.entries.map((id) => readHistoryTransactionManifest(git$, id, repository))
   );
   return manifests.filter((manifest): manifest is HistoryTransactionManifest => manifest !== null);
}

/**
 * Sets the current worktree undo/redo cursor.
 * @param git$ - Git executable/context from GdxContext.
 * @param cursor - Index of the next redo entry.
 * @returns Updated timeline.
 */
export async function setHistoryCursor(
   git$: GdxContext['git$'],
   cursor: number,
   repository?: GdxRepositoryLocation
): Promise<HistoryTimeline> {
   const paths = repository
      ? createHistoryStoragePaths(repository)
      : await resolveHistoryStoragePaths(git$);
   return await withResolvedHistoryLock(paths, async () => {
      const timeline =
         (await readTimelineFile(paths.timelineFile, paths.id)) ??
         createEmptyTimeline(paths.id, new Date().toISOString());
      if (!Number.isInteger(cursor) || cursor < 0 || cursor > timeline.entries.length) {
         throw new HistoryStorageError(
            `History cursor ${cursor} is outside 0..${timeline.entries.length}.`
         );
      }
      if (cursor === timeline.cursor) return timeline;

      await ensureHistoryDirectories(paths);
      const nextTimeline = {
         ...timeline,
         revision: timeline.revision + 1,
         updatedAt: new Date().toISOString(),
         cursor,
      };
      await atomicWriteJson(paths.timelineFile, nextTimeline);
      return nextTimeline;
   });
}

/**
 * Moves the cursor by a signed number of entries.
 * @param git$ - Git executable/context from GdxContext.
 * @param delta - Negative for undo and positive for redo.
 * @returns Updated timeline.
 */
export async function moveHistoryCursor(
   git$: GdxContext['git$'],
   delta: number
): Promise<HistoryTimeline> {
   if (!Number.isInteger(delta)) {
      throw new HistoryStorageError('History cursor delta must be an integer.');
   }
   const timeline = await readHistoryTimeline(git$);
   return await setHistoryCursor(git$, timeline.cursor + delta);
}

/**
 * Discards the current worktree's redo tail and obsolete transaction files.
 * @param git$ - Git executable/context from GdxContext.
 * @returns Discarded IDs and updated timeline.
 */
export async function discardHistoryRedoTail(git$: GdxContext['git$']): Promise<{
   discardedIds: HistoryTransactionId[];
   timeline: HistoryTimeline;
}> {
   const paths = await resolveHistoryStoragePaths(git$);
   return await withResolvedHistoryLock(paths, async () => {
      const timeline =
         (await readTimelineFile(paths.timelineFile, paths.id)) ??
         createEmptyTimeline(paths.id, new Date().toISOString());
      const discardedIds = timeline.entries.slice(timeline.cursor);
      if (discardedIds.length === 0) return { discardedIds, timeline };

      const nextTimeline: HistoryTimeline = {
         ...timeline,
         revision: timeline.revision + 1,
         updatedAt: new Date().toISOString(),
         entries: timeline.entries.slice(0, timeline.cursor),
      };
      await atomicWriteJson(paths.timelineFile, nextTimeline);
      await removeTransactionFiles(paths, discardedIds);
      return { discardedIds, timeline: nextTimeline };
   });
}

/** Alias for discardHistoryRedoTail. */
export const discardRedoTail = discardHistoryRedoTail;

/**
 * Prunes the oldest entries to the requested retention limit.
 * @param git$ - Git executable/context from GdxContext.
 * @param maxEntries - Maximum retained timeline entries.
 * @returns Pruned IDs and updated timeline.
 */
export async function pruneHistory(
   git$: GdxContext['git$'],
   maxEntries: number = DEFAULT_HISTORY_MAX_ENTRIES,
   repository?: GdxRepositoryLocation
): Promise<{ prunedIds: HistoryTransactionId[]; timeline: HistoryTimeline }> {
   const limit = normalizeMaxEntries(maxEntries);
   const paths = repository
      ? createHistoryStoragePaths(repository)
      : await resolveHistoryStoragePaths(git$);
   return await withResolvedHistoryLock(paths, async () => {
      const timeline =
         (await readTimelineFile(paths.timelineFile, paths.id)) ??
         createEmptyTimeline(paths.id, new Date().toISOString());
      const count = Math.max(0, timeline.entries.length - limit);
      const prunedIds = timeline.entries.slice(0, count);
      if (!prunedIds.length) return { prunedIds, timeline };
      const nextTimeline: HistoryTimeline = {
         ...timeline,
         revision: timeline.revision + 1,
         updatedAt: new Date().toISOString(),
         entries: timeline.entries.slice(count),
         cursor: Math.max(0, timeline.cursor - count),
      };
      await atomicWriteJson(paths.timelineFile, nextTimeline);
      await removeTransactionFiles(paths, prunedIds);
      return { prunedIds, timeline: nextTimeline };
   });
}

/**
 * Resolves an exact/unique ID or a zero-based ~index selector.
 * @param git$ - Git executable/context from GdxContext.
 * @param selector - Transaction ID, unique ID prefix, or ~index.
 * @param options - Relative selector scope; defaults to applied entries.
 * @returns Stable ID and timeline position.
 */
export async function resolveHistorySelector(
   git$: GdxContext['git$'],
   selector: string,
   options: HistorySelectorOptions = {}
): Promise<HistoryTimelineSelection> {
   if (!selector) throw new HistorySelectorError('History selector cannot be empty.');
   const timeline = await readHistoryTimeline(git$, options.repository);
   const scope = options.scope ?? 'applied';
   let id: string;
   let relativeIndex: number;

   const relativeMatch = /^~(\d+)$/.exec(selector);
   if (relativeMatch) {
      relativeIndex = Number(relativeMatch[1]);
      const candidates = relativeSelectorCandidates(timeline, scope);
      id = candidates[relativeIndex] ?? '';
      if (!id) {
         throw new HistorySelectorError(
            `History selector ${selector} is outside the ${scope} timeline.`
         );
      }
   } else {
      const matches = timeline.entries.filter((candidate) => candidate === selector);
      const prefixMatches = matches.length
         ? matches
         : timeline.entries.filter((candidate) => candidate.startsWith(selector));
      const uniqueMatches = [...new Set(prefixMatches)];
      if (uniqueMatches.length === 0) {
         throw new HistorySelectorError(`Unknown history transaction: ${selector}`);
      }
      if (uniqueMatches.length > 1) {
         throw new HistorySelectorError(`Ambiguous history transaction prefix: ${selector}`);
      }
      id = uniqueMatches[0];
      relativeIndex = relativeSelectorCandidates(timeline, scope).indexOf(id);
   }

   const index = timeline.entries.indexOf(id);
   return {
      id,
      index,
      relativeIndex,
      state: index < timeline.cursor ? 'applied' : 'redo',
   };
}

/**
 * Resolves a selector and loads its transaction manifest.
 * @param git$ - Git executable/context from GdxContext.
 * @param selector - Transaction ID, unique ID prefix, or ~index.
 * @param options - Relative selector scope.
 * @returns The selected transaction manifest.
 */
export async function resolveHistoryTransaction(
   git$: GdxContext['git$'],
   selector: string,
   options: HistorySelectorOptions = {}
): Promise<HistoryTransactionManifest> {
   const selection = await resolveHistorySelector(git$, selector, options);
   const manifest = await readHistoryTransactionManifest(git$, selection.id, options.repository);
   if (!manifest) {
      throw new HistoryStorageError(`History manifest is missing: ${selection.id}`);
   }
   return manifest;
}

/**
 * Reads observer metadata without creating storage.
 * @param git$ - Git executable/context from GdxContext.
 * @returns Observer metadata, or null when absent.
 */
export async function readHistoryObserverMetadata(
   git$: GdxContext['git$']
): Promise<HistoryObserverMetadata | null> {
   const paths = await resolveHistoryStoragePaths(git$);
   const metadata = await readJsonFile<HistoryObserverMetadata>(paths.observerMetadataFile);
   if (!metadata) return null;
   assertObserverMetadata(metadata, paths.id);
   return metadata;
}

/**
 * Creates observer metadata for the current worktree when absent.
 * @param git$ - Git executable/context from GdxContext.
 * @param observerId - Optional preassigned observer identity.
 * @returns Existing or newly created observer metadata.
 */
export async function ensureHistoryObserverMetadata(
   git$: GdxContext['git$'],
   observerId = `observer_${crypto.randomUUID().replaceAll('-', '')}`
): Promise<HistoryObserverMetadata> {
   const paths = await resolveHistoryStoragePaths(git$);
   assertSafeId(observerId, 'observer');
   return await withResolvedHistoryLock(paths, async () => {
      const existing = await readJsonFile<HistoryObserverMetadata>(paths.observerMetadataFile);
      if (existing) {
         assertObserverMetadata(existing, paths.id);
         return existing;
      }

      await ensureHistoryDirectories(paths);
      const now = new Date().toISOString();
      const metadata: HistoryObserverMetadata = {
         schemaVersion: HISTORY_SCHEMA_VERSION,
         observerId,
         worktreeId: paths.id,
         installedAt: now,
         updatedAt: now,
         nextSequence: 0,
         lastObservedAt: null,
         lastTransactionId: null,
      };
      await atomicWriteJson(paths.observerMetadataFile, metadata);
      return metadata;
   });
}

/**
 * Persists complete observer metadata for the current worktree.
 * @param git$ - Git executable/context from GdxContext.
 * @param metadata - Metadata to persist.
 */
export async function writeHistoryObserverMetadata(
   git$: GdxContext['git$'],
   metadata: HistoryObserverMetadata
): Promise<void> {
   const paths = await resolveHistoryStoragePaths(git$);
   assertObserverMetadata(metadata, paths.id);
   await withResolvedHistoryLock(paths, async () => {
      await ensureHistoryDirectories(paths);
      await atomicWriteJson(paths.observerMetadataFile, metadata);
   });
}

/**
 * Appends one observer event to the per-worktree durable spool.
 * @param git$ - Git executable/context from GdxContext.
 * @param input - Observer event data.
 * @returns Persisted event with stable ID and sequence.
 */
export async function enqueueHistoryObserverEvent(
   git$: GdxContext['git$'],
   input: HistoryObserverSpoolInput
): Promise<HistoryObserverSpoolEntry> {
   const paths = await resolveHistoryStoragePaths(git$);
   return await withResolvedHistoryLock(paths, async () => {
      await ensureHistoryDirectories(paths);
      const existingMetadata = await readJsonFile<HistoryObserverMetadata>(
         paths.observerMetadataFile
      );
      if (existingMetadata) assertObserverMetadata(existingMetadata, paths.id);
      const now = input.createdAt ?? new Date().toISOString();
      const metadata =
         existingMetadata ??
         ({
            schemaVersion: HISTORY_SCHEMA_VERSION,
            observerId: `observer_${crypto.randomUUID().replaceAll('-', '')}`,
            worktreeId: paths.id,
            installedAt: now,
            updatedAt: now,
            nextSequence: 0,
            lastObservedAt: null,
            lastTransactionId: null,
         } satisfies HistoryObserverMetadata);
      const id = input.id ?? `event_${crypto.randomUUID().replaceAll('-', '')}`;
      assertSafeId(id, 'observer event');
      const eventFile = path.join(paths.worktreeSpoolDir, `${id}.json`);
      if (await pathExists(eventFile)) {
         throw new HistoryStorageError(`History observer event already exists: ${id}`);
      }
      const entry: HistoryObserverSpoolEntry = {
         ...input,
         schemaVersion: HISTORY_SCHEMA_VERSION,
         id,
         worktreeId: paths.id,
         sequence: metadata.nextSequence,
         createdAt: now,
      };

      const nextMetadata: HistoryObserverMetadata = {
         ...metadata,
         updatedAt: now,
         nextSequence: metadata.nextSequence + 1,
         lastObservedAt: now,
         lastTransactionId: entry.transactionId ?? metadata.lastTransactionId,
      };
      await atomicWriteJson(eventFile, entry);
      await atomicWriteJson(paths.observerMetadataFile, nextMetadata);
      return entry;
   });
}

/** Alias for enqueueHistoryObserverEvent. */
export const enqueueObserverSpoolEntry = enqueueHistoryObserverEvent;

/**
 * Lists pending observer events in stable sequence order.
 * @param git$ - Git executable/context from GdxContext.
 * @returns Pending spool entries.
 */
export async function listHistoryObserverEvents(
   git$: GdxContext['git$']
): Promise<HistoryObserverSpoolEntry[]> {
   const paths = await resolveHistoryStoragePaths(git$);
   const fileNames = await fs.readdir(paths.worktreeSpoolDir).catch((error: unknown) => {
      if (isFileSystemError(error, 'ENOENT')) return [];
      throw error;
   });
   const entries = await Promise.all(
      fileNames
         .filter((fileName) => fileName.endsWith('.json'))
         .map(async (fileName) => {
            const entry = await readJsonFile<HistoryObserverSpoolEntry>(
               path.join(paths.worktreeSpoolDir, fileName)
            );
            if (entry) assertObserverSpoolEntry(entry, paths.id);
            return entry;
         })
   );
   return entries
      .filter((entry): entry is HistoryObserverSpoolEntry => entry !== null)
      .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
}

/** Alias for listHistoryObserverEvents. */
export const listObserverSpoolEntries = listHistoryObserverEvents;

/**
 * Removes one processed observer event.
 * @param git$ - Git executable/context from GdxContext.
 * @param id - Exact spool event ID.
 */
export async function removeHistoryObserverEvent(
   git$: GdxContext['git$'],
   id: string
): Promise<void> {
   assertSafeId(id, 'observer event');
   const paths = await resolveHistoryStoragePaths(git$);
   await withResolvedHistoryLock(paths, async () => {
      await fs.unlink(path.join(paths.worktreeSpoolDir, `${id}.json`)).catch((error: unknown) => {
         if (!isFileSystemError(error, 'ENOENT')) throw error;
      });
   });
}

/** Alias for removeHistoryObserverEvent. */
export const removeObserverSpoolEntry = removeHistoryObserverEvent;

/**
 * Resolves a directory through the filesystem while retaining a useful fallback.
 * @param directory - Directory reported by Git.
 * @returns Canonical absolute directory.
 */
async function canonicalizeDirectory(directory: string): Promise<string> {
   const resolved = path.resolve(directory);
   return await fs.realpath(resolved).catch(() => resolved);
}

/**
 * Derives a stable worktree ID from Git's common and per-worktree directories.
 * @param commonGitDir - Canonical common Git directory.
 * @param gitDir - Canonical per-worktree Git directory.
 * @returns Path-safe worktree ID.
 */
function createWorktreeId(commonGitDir: string, gitDir: string): string {
   const normalize = (value: string) =>
      (process.platform === 'win32' ? value.toLowerCase() : value).replaceAll('\\', '/');
   const digest = crypto
      .createHash('sha256')
      .update(`${normalize(commonGitDir)}\0${normalize(gitDir)}`)
      .digest('hex')
      .slice(0, 24);
   return `wt_${digest}`;
}

/**
 * Acquires and releases the repo-global lock around one operation.
 * @param paths - Resolved storage paths.
 * @param operation - Serialized operation.
 * @param options - Lock timing options.
 * @returns Operation result.
 */
async function withResolvedHistoryLock<T>(
   paths: HistoryStoragePaths,
   operation: () => Promise<T>,
   options: HistoryLockOptions = {}
): Promise<T> {
   const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
   const staleMs = options.staleMs ?? DEFAULT_STALE_LOCK_MS;
   const retryMs = options.retryMs ?? DEFAULT_LOCK_RETRY_MS;
   const token = crypto.randomUUID();
   const startedAt = Date.now();
   await fs.mkdir(paths.locksDir, { recursive: true });

   while (true) {
      try {
         const handle = await fs.open(paths.lockFile, 'wx');
         try {
            await handle.writeFile(
               JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() })
            );
            await handle.sync();
         } finally {
            await handle.close();
         }
         break;
      } catch (error) {
         if (!isFileSystemError(error, 'EEXIST')) throw error;
         await removeStaleLock(paths.lockFile, staleMs);
         if (Date.now() - startedAt >= timeoutMs) {
            throw new HistoryLockTimeoutError(paths.lockFile);
         }
         await delay(retryMs);
      }
   }

   try {
      return await operation();
   } finally {
      await releaseLock(paths.lockFile, token);
   }
}

/**
 * Removes a lock whose mtime exceeds the stale threshold.
 * @param lockFile - Lock path.
 * @param staleMs - Stale threshold.
 */
async function removeStaleLock(lockFile: string, staleMs: number): Promise<void> {
   const stat = await fs.stat(lockFile).catch((error: unknown) => {
      if (isFileSystemError(error, 'ENOENT')) return null;
      throw error;
   });
   if (!stat || Date.now() - stat.mtimeMs <= staleMs) return;
   await fs.unlink(lockFile).catch((error: unknown) => {
      if (!isFileSystemError(error, 'ENOENT')) throw error;
   });
}

/**
 * Releases a lock only when it is still owned by this operation.
 * @param lockFile - Lock path.
 * @param token - Ownership token.
 */
async function releaseLock(lockFile: string, token: string): Promise<void> {
   try {
      const raw = await fs.readFile(lockFile, 'utf8');
      const lock = JSON.parse(raw) as { token?: unknown };
      if (lock.token !== token) return;
      await fs.unlink(lockFile);
   } catch (error) {
      if (!isFileSystemError(error, 'ENOENT')) throw error;
   }
}

/**
 * Creates all directories used by current history storage.
 * @param paths - Resolved storage paths.
 */
async function ensureHistoryDirectories(paths: HistoryStoragePaths): Promise<void> {
   await Promise.all(
      [
         paths.historyDir,
         paths.timelinesDir,
         paths.transactionsDir,
         paths.observersDir,
         paths.worktreeSpoolDir,
         paths.locksDir,
      ].map((directory) => fs.mkdir(directory, { recursive: true }))
   );
}

/**
 * Writes formatted JSON to a temporary sibling and atomically renames it.
 * @param filePath - Destination path.
 * @param value - JSON-compatible value.
 */
async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
   await fs.mkdir(path.dirname(filePath), { recursive: true });
   const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
   let handle: fs.FileHandle | null = null;
   try {
      handle = await fs.open(temporaryPath, 'wx');
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporaryPath, filePath);
   } finally {
      if (handle) await handle.close().catch(() => undefined);
      await fs.unlink(temporaryPath).catch(() => undefined);
   }
}

/**
 * Reads and parses a JSON file, treating absence as null.
 * @param filePath - JSON file path.
 * @returns Parsed JSON value or null.
 */
async function readJsonFile<T>(filePath: string): Promise<T | null> {
   let raw: string;
   try {
      raw = await fs.readFile(filePath, 'utf8');
   } catch (error) {
      if (isFileSystemError(error, 'ENOENT')) return null;
      throw error;
   }

   try {
      return JSON.parse(raw) as T;
   } catch (error) {
      throw new HistoryStorageError(
         `Invalid history JSON at ${filePath}: ${error instanceof Error ? error.message : String(error)}`
      );
   }
}

/**
 * Reads and validates repository-level state.
 * @param filePath - State file path.
 * @returns State or null.
 */
async function readRepositoryStateFile(filePath: string): Promise<HistoryRepositoryState | null> {
   const state = await readJsonFile<HistoryRepositoryState>(filePath);
   if (!state) return null;
   assertSchemaVersion(state, filePath);
   if (
      state.storageVersion !== HISTORY_STORAGE_VERSION ||
      !Number.isInteger(state.revision) ||
      !isRecord(state.worktrees)
   ) {
      throw new HistoryStorageError(`Unsupported history repository state at ${filePath}.`);
   }
   return state;
}

/**
 * Reads and validates a worktree timeline.
 * @param filePath - Timeline path.
 * @param worktreeId - Expected worktree ID.
 * @returns Timeline or null.
 */
async function readTimelineFile(
   filePath: string,
   worktreeId: string
): Promise<HistoryTimeline | null> {
   const timeline = await readJsonFile<HistoryTimeline>(filePath);
   if (!timeline) return null;
   assertSchemaVersion(timeline, filePath);
   if (
      timeline.worktreeId !== worktreeId ||
      !Array.isArray(timeline.entries) ||
      !timeline.entries.every((id) => typeof id === 'string') ||
      !Number.isInteger(timeline.cursor) ||
      timeline.cursor < 0 ||
      timeline.cursor > timeline.entries.length ||
      !Number.isInteger(timeline.revision)
   ) {
      throw new HistoryStorageError(`Invalid history timeline at ${filePath}.`);
   }
   return timeline;
}

/**
 * Builds an empty repository state document.
 * @param now - ISO timestamp.
 * @returns Empty state.
 */
function createEmptyRepositoryState(now: string): HistoryRepositoryState {
   return {
      schemaVersion: HISTORY_SCHEMA_VERSION,
      storageVersion: HISTORY_STORAGE_VERSION,
      revision: 0,
      createdAt: now,
      updatedAt: now,
      worktrees: {},
   };
}

/**
 * Builds an empty per-worktree timeline.
 * @param worktreeId - Stable worktree ID.
 * @param now - ISO timestamp.
 * @returns Empty timeline.
 */
function createEmptyTimeline(worktreeId: string, now: string): HistoryTimeline {
   return {
      schemaVersion: HISTORY_SCHEMA_VERSION,
      worktreeId,
      revision: 0,
      createdAt: now,
      updatedAt: now,
      entries: [],
      cursor: 0,
   };
}

/**
 * Adds or refreshes the current worktree registration.
 * @param state - Existing repository state.
 * @param paths - Current worktree paths.
 * @param now - ISO timestamp.
 * @returns Original state when unchanged, otherwise a revised state.
 */
function registerWorktree(
   state: HistoryRepositoryState,
   paths: HistoryStoragePaths,
   now: string
): HistoryRepositoryState {
   const existing = state.worktrees[paths.id];
   const timelinePath = path.relative(paths.historyDir, paths.timelineFile).replaceAll('\\', '/');
   const registration: HistoryWorktreeRegistration = {
      id: paths.id,
      root: paths.root,
      commonGitDir: paths.commonGitDir,
      gitDir: paths.gitDir,
      timelinePath,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
   };
   if (
      existing &&
      existing.root === registration.root &&
      existing.gitDir === registration.gitDir &&
      existing.commonGitDir === registration.commonGitDir &&
      existing.timelinePath === registration.timelinePath
   ) {
      return state;
   }
   return {
      ...state,
      revision: state.revision + 1,
      updatedAt: now,
      worktrees: { ...state.worktrees, [paths.id]: registration },
   };
}

/**
 * Returns the transaction manifest path after validating its ID.
 * @param paths - Resolved storage paths.
 * @param id - Transaction ID.
 * @returns Manifest path.
 */
function transactionFile(paths: HistoryStoragePaths, id: string): string {
   assertSafeId(id, 'transaction');
   return path.join(paths.transactionsDir, `${id}.json`);
}

/** Removes obsolete manifests and their optional local artifacts. */
async function removeTransactionFiles(paths: HistoryStoragePaths, ids: readonly string[]): Promise<void> {
   await Promise.all(
      [...new Set(ids)].map(async (id) => {
         assertSafeId(id, 'transaction');
         await fs.rm(transactionFile(paths, id), { force: true });
         await fs.rm(path.join(paths.historyDir, 'artifacts', id), {
            recursive: true,
            force: true,
         });
      })
   );
}

/**
 * Returns IDs in relative-selector order for a timeline scope.
 * @param timeline - Current timeline.
 * @param scope - Applied, redo, or all entries.
 * @returns IDs where index zero is nearest/current for the scope.
 */
function relativeSelectorCandidates(
   timeline: HistoryTimeline,
   scope: HistorySelectorScope
): string[] {
   if (scope === 'redo') return timeline.entries.slice(timeline.cursor);
   if (scope === 'all') return timeline.entries.slice().reverse();
   return timeline.entries.slice(0, timeline.cursor).reverse();
}

/**
 * Validates a transaction manifest and worktree ownership.
 * @param manifest - Manifest to validate.
 * @param worktreeId - Expected worktree ID.
 */
function assertTransactionManifest(manifest: HistoryTransactionManifest, worktreeId: string): void {
   assertSchemaVersion(manifest, `transaction ${manifest.id || '<unknown>'}`);
   assertSafeId(manifest.id, 'transaction');
   if (
      manifest.worktreeId !== worktreeId ||
      typeof manifest.createdAt !== 'string' ||
      !isHistorySource(manifest.source) ||
      !isHistoryCapability(manifest.capability) ||
      (manifest.command !== undefined && !isHistoryCommandMetadata(manifest.command)) ||
      !Array.isArray(manifest.refs) ||
      !manifest.refs.every(isHistoryRefChange) ||
      (manifest.head !== undefined && !isHistoryHeadChange(manifest.head)) ||
      (manifest.index !== undefined && !isHistoryIndexChange(manifest.index)) ||
      (manifest.paths !== undefined && !manifest.paths.every(isHistoryPathChange)) ||
      (manifest.control !== undefined && !isHistoryControlChange(manifest.control)) ||
      !isHistoryFingerprints(manifest.fingerprints) ||
      (manifest.undoUnavailableReason !== undefined &&
         typeof manifest.undoUnavailableReason !== 'string')
   ) {
      throw new HistoryStorageError(`Invalid history transaction manifest: ${manifest.id}.`);
   }
}

/**
 * Validates observer metadata and worktree ownership.
 * @param metadata - Observer metadata.
 * @param worktreeId - Expected worktree ID.
 */
function assertObserverMetadata(metadata: HistoryObserverMetadata, worktreeId: string): void {
   assertSchemaVersion(metadata, 'observer metadata');
   assertSafeId(metadata.observerId, 'observer');
   if (
      metadata.worktreeId !== worktreeId ||
      !Number.isInteger(metadata.nextSequence) ||
      metadata.nextSequence < 0
   ) {
      throw new HistoryStorageError('Invalid history observer metadata.');
   }
}

/**
 * Validates one spool entry and worktree ownership.
 * @param entry - Spool entry.
 * @param worktreeId - Expected worktree ID.
 */
function assertObserverSpoolEntry(entry: HistoryObserverSpoolEntry, worktreeId: string): void {
   assertSchemaVersion(entry, `observer event ${entry.id || '<unknown>'}`);
   assertSafeId(entry.id, 'observer event');
   if (
      entry.worktreeId !== worktreeId ||
      !Number.isInteger(entry.sequence) ||
      !isHistorySource(entry.source)
   ) {
      throw new HistoryStorageError(`Invalid history observer event: ${entry.id}.`);
   }
}

/**
 * Checks the persisted source literal contract.
 * @param value - Source value.
 * @returns Whether the source is supported.
 */
function isHistorySource(value: unknown): boolean {
   return HISTORY_SOURCES.some((source) => source === value);
}

/**
 * Checks the persisted capability literal contract.
 * @param value - Capability value.
 * @returns Whether the capability is supported.
 */
function isHistoryCapability(value: unknown): boolean {
   return HISTORY_CAPABILITIES.some((capability) => capability === value);
}

/**
 * Checks command provenance fields embedded in a manifest or observer event.
 * @param value - Command metadata.
 * @returns Whether all required command fields are valid.
 */
function isHistoryCommandMetadata(value: unknown): boolean {
   return (
      isRecord(value) &&
      typeof value.command === 'string' &&
      Array.isArray(value.argv) &&
      value.argv.every((argument) => typeof argument === 'string') &&
      typeof value.cwd === 'string' &&
      typeof value.startedAt === 'string' &&
      typeof value.finishedAt === 'string' &&
      (value.exitCode === null || Number.isInteger(value.exitCode))
   );
}

/**
 * Checks a missing, direct-OID, or symbolic ref value.
 * @param value - Ref state.
 * @returns Whether the persisted discriminated union is valid.
 */
function isHistoryRefState(value: unknown): boolean {
   if (!isRecord(value)) return false;
   if (value.kind === 'missing') return true;
   if (value.kind === 'oid') return typeof value.oid === 'string';
   return (
      value.kind === 'symbolic' &&
      typeof value.target === 'string' &&
      (value.oid === null || typeof value.oid === 'string')
   );
}

/**
 * Checks one ref transition.
 * @param value - Ref change.
 * @returns Whether both boundaries use the strict ref union.
 */
function isHistoryRefChange(value: unknown): boolean {
   return (
      isRecord(value) &&
      typeof value.name === 'string' &&
      isHistoryRefState(value.before) &&
      isHistoryRefState(value.after)
   );
}

/**
 * Checks one HEAD boundary state.
 * @param value - HEAD state.
 * @returns Whether the HEAD state is valid.
 */
function isHistoryHeadState(value: unknown): boolean {
   return isRecord(value) && typeof value.unborn === 'boolean' && isHistoryRefState(value.value);
}

/**
 * Checks a HEAD transition.
 * @param value - HEAD change.
 * @returns Whether both states are valid.
 */
function isHistoryHeadChange(value: unknown): boolean {
   return isRecord(value) && isHistoryHeadState(value.before) && isHistoryHeadState(value.after);
}

/**
 * Checks a persisted content fingerprint.
 * @param value - Fingerprint value.
 * @returns Whether algorithm and digest are valid strings.
 */
function isHistoryFingerprint(value: unknown): boolean {
   return (
      isRecord(value) &&
      (value.algorithm === 'sha256' || value.algorithm === 'git-oid') &&
      typeof value.value === 'string'
   );
}

/**
 * Checks a durable artifact reference.
 * @param value - Artifact value.
 * @returns Whether path, size, and fingerprint are valid.
 */
function isHistoryArtifact(value: unknown): boolean {
   return (
      isRecord(value) &&
      typeof value.path === 'string' &&
      Number.isSafeInteger(value.size) &&
      Number(value.size) >= 0 &&
      isHistoryFingerprint(value.fingerprint)
   );
}

/**
 * Checks an index boundary state.
 * @param value - Index state.
 * @returns Whether state metadata is valid.
 */
function isHistoryIndexState(value: unknown): boolean {
   return (
      isRecord(value) &&
      (value.treeOid === null || typeof value.treeOid === 'string') &&
      Number.isSafeInteger(value.entryCount) &&
      Number(value.entryCount) >= 0 &&
      isHistoryFingerprint(value.fingerprint)
   );
}

/**
 * Checks a tree or raw index restoration recipe.
 * @param value - Index recipe.
 * @returns Whether the recipe satisfies the durable contract.
 */
function isHistoryIndexRecipe(value: unknown): boolean {
   if (!isRecord(value)) return false;
   if (value.kind === 'tree') return typeof value.treeOid === 'string';
   if (value.kind === 'raw') {
      return isHistoryArtifact(value.blob) && typeof value.checksum === 'string';
   }
   return (
      value.kind === 'shared-blobs' &&
      Array.isArray(value.blobs) &&
      value.blobs.every(
         (shared) =>
            isRecord(shared) && typeof shared.oid === 'string' && isHistoryArtifact(shared.blob)
      ) &&
      typeof value.checksum === 'string'
   );
}

/**
 * Checks an index transition and restoration recipes.
 * @param value - Index change.
 * @returns Whether boundary states and recipes are valid.
 */
function isHistoryIndexChange(value: unknown): boolean {
   return (
      isRecord(value) &&
      isHistoryIndexState(value.before) &&
      isHistoryIndexState(value.after) &&
      isHistoryIndexRecipe(value.undo) &&
      (value.redo === undefined || isHistoryIndexRecipe(value.redo))
   );
}

/**
 * Checks a lossless path identity.
 * @param value - Raw path value.
 * @returns Whether base64 bytes, display text, and tracked state are present.
 */
function isHistoryRawPath(value: unknown): boolean {
   return (
      isRecord(value) &&
      typeof value.bytesBase64 === 'string' &&
      typeof value.display === 'string' &&
      typeof value.tracked === 'boolean'
   );
}

/**
 * Checks one path boundary state.
 * @param value - Path state.
 * @returns Whether path metadata is valid.
 */
function isHistoryPathState(value: unknown): boolean {
   return (
      isRecord(value) &&
      ['absent', 'file', 'directory', 'symlink', 'gitlink'].includes(String(value.kind)) &&
      (value.mode === null || typeof value.mode === 'string') &&
      (value.size === null || (Number.isSafeInteger(value.size) && Number(value.size) >= 0)) &&
      (value.oid === null || typeof value.oid === 'string') &&
      (value.fingerprint === null || isHistoryFingerprint(value.fingerprint))
   );
}

/**
 * Checks one path transition.
 * @param value - Path change.
 * @returns Whether lossless identity and both states are valid.
 */
function isHistoryPathChange(value: unknown): boolean {
   return (
      isRecord(value) &&
      isHistoryRawPath(value.path) &&
      (value.previousPath === undefined || isHistoryRawPath(value.previousPath)) &&
      ['add', 'modify', 'delete', 'rename', 'copy', 'type-change', 'unmerged'].includes(
         String(value.kind)
      ) &&
      isHistoryPathState(value.before) &&
      isHistoryPathState(value.after) &&
      typeof value.staged === 'boolean' &&
      (value.artifact === undefined || isHistoryArtifact(value.artifact))
   );
}

/**
 * Checks one Git control boundary state.
 * @param value - Control state.
 * @returns Whether operation metadata and fingerprint are valid.
 */
function isHistoryControlState(value: unknown): boolean {
   return (
      isRecord(value) &&
      ['none', 'merge', 'rebase', 'cherry-pick', 'revert', 'bisect', 'am'].includes(
         String(value.kind)
      ) &&
      typeof value.inProgress === 'boolean' &&
      (value.headName === null || typeof value.headName === 'string') &&
      (value.originalHead === null || typeof value.originalHead === 'string') &&
      (value.step === null || Number.isInteger(value.step)) &&
      (value.totalSteps === null || Number.isInteger(value.totalSteps)) &&
      isHistoryFingerprint(value.fingerprint)
   );
}

/**
 * Checks a control transition and restoration artifacts.
 * @param value - Control change.
 * @returns Whether both states and artifacts are valid.
 */
function isHistoryControlChange(value: unknown): boolean {
   return (
      isRecord(value) &&
      isHistoryControlState(value.before) &&
      isHistoryControlState(value.after) &&
      Array.isArray(value.artifacts) &&
      value.artifacts.every(isHistoryArtifact)
   );
}

/**
 * Checks all fingerprints for one repository boundary.
 * @param value - Boundary fingerprints.
 * @returns Whether every protected surface has a fingerprint.
 */
function isHistoryRepositoryFingerprint(value: unknown): boolean {
   return (
      isRecord(value) &&
      isHistoryFingerprint(value.refs) &&
      isHistoryFingerprint(value.head) &&
      isHistoryFingerprint(value.index) &&
      isHistoryFingerprint(value.paths) &&
      isHistoryFingerprint(value.control) &&
      isHistoryFingerprint(value.combined)
   );
}

/**
 * Checks before/after repository fingerprints.
 * @param value - Transaction fingerprints.
 * @returns Whether both boundaries are complete.
 */
function isHistoryFingerprints(value: unknown): boolean {
   return (
      isRecord(value) &&
      isHistoryRepositoryFingerprint(value.before) &&
      isHistoryRepositoryFingerprint(value.after)
   );
}

/**
 * Verifies the current persisted schema version.
 * @param value - Persisted value.
 * @param label - Diagnostic location.
 */
function assertSchemaVersion(value: unknown, label: string): void {
   if (!isRecord(value) || value.schemaVersion !== HISTORY_SCHEMA_VERSION) {
      throw new HistoryStorageError(
         `Unsupported history schema at ${label}; expected ${HISTORY_SCHEMA_VERSION}.`
      );
   }
}

/**
 * Prevents IDs from escaping their designated storage directory.
 * @param id - Persisted identifier.
 * @param label - Identifier kind for diagnostics.
 */
function assertSafeId(id: string, label: string): void {
   if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) {
      throw new HistoryStorageError(`Invalid ${label} ID: ${id}`);
   }
}

/**
 * Tests for a plain non-null object.
 * @param value - Value to inspect.
 * @returns True for non-array objects.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
   return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Tests a filesystem error code without weakening catch variables to any.
 * @param error - Unknown thrown value.
 * @param code - Expected error code.
 * @returns Whether the value has the requested code.
 */
function isFileSystemError(error: unknown, code: string): boolean {
   return isRecord(error) && error.code === code;
}

/** Validates and defaults the bounded timeline size. */
function normalizeMaxEntries(maxEntries = DEFAULT_HISTORY_MAX_ENTRIES): number {
   if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new HistoryStorageError('History maxEntries must be a positive integer.');
   }
   return maxEntries;
}

/**
 * Checks whether a path exists.
 * @param targetPath - Filesystem path.
 * @returns True when stat succeeds.
 */
async function pathExists(targetPath: string): Promise<boolean> {
   return await fs
      .stat(targetPath)
      .then(() => true)
      .catch((error: unknown) => {
         if (isFileSystemError(error, 'ENOENT')) return false;
         throw error;
      });
}

/**
 * Waits before retrying lock acquisition.
 * @param milliseconds - Delay duration.
 */
async function delay(milliseconds: number): Promise<void> {
   await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
