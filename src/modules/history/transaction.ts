import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { execa } from 'execa';

import { GdxContext, GdxRepositoryLocation } from '@/common/types';
import { ReversibleCapturePlan } from '@/modules/history/classifier';
import {
   createHistoryTransactionId,
   createHistoryStoragePaths,
   listHistoryTransactions,
   readHistoryTimeline,
   readHistoryTransactionManifest,
   recordHistoryTransaction,
   removeHistoryTransactions,
   resolveHistoryStoragePaths,
   setHistoryCursor,
} from '@/modules/history/storage';
import {
   HistoryArtifactReference,
   HistoryCommandMetadata,
   HistoryHeadState,
   HistoryInverseRecipe,
   HistoryRefChange,
   HistoryRefState,
   HistoryRepositoryFingerprint,
   HISTORY_SNAPSHOT_REF_PREFIX,
   HistorySnapshotState,
   HistorySource,
   HistoryTransactionId,
   HistoryTransactionInput,
   HistoryTransactionManifest,
} from '@/modules/history/types';
import Logger from '@/utils/logger';

/** Guard inherited by every Git child started by the history engine. */
export const HISTORY_GIT_CHILD_ENV = { GDX_HISTORY_GUARD: '1' } as const;

interface GitResult {
   stdout: Buffer;
   stderr: Buffer;
   exitCode: number;
}

interface Boundary {
   head?: HistoryHeadState;
   refs: Map<string, HistoryRefState>;
   index?: Buffer | null;
   indexTree?: string;
   indexSemanticFingerprint?: string;
   worktreeTree?: string;
}

/** In-memory pre-command candidate containing only the selected inverse inputs. */
export interface HistoryTransactionCapture {
   ctx: GdxContext;
   id: string;
   root: string;
   gitDir: string;
   historyDir: string;
   repository: GdxRepositoryLocation;
   source: HistorySource;
   action: string;
   argv: string[];
   startedAt: string;
   plan: ReversibleCapturePlan;
   before: Boundary;
}

/** Options used to begin a routed transaction. */
export interface BeginHistoryTransactionOptions {
   action: string;
   argv: readonly string[];
   source?: HistorySource;
   startedAt?: string;
   capture?: ReversibleCapturePlan;
}

/** Options used when finalizing and recording a routed transaction. */
export interface FinalizeHistoryTransactionOptions {
   exitCode?: number | null;
   finishedAt?: string;
   maxEntries?: number;
   record?: boolean;
}

/** A detected stale precondition that prevents a safe undo or redo. */
export interface HistoryDivergence {
   transaction: HistoryTransactionManifest;
   direction: HistoryApplyDirection;
   surfaces: Array<keyof HistoryRepositoryFingerprint>;
   expected: HistoryRepositoryFingerprint;
   actual: HistoryRepositoryFingerprint;
}

/** Direction in which a recorded transaction is being applied. */
export type HistoryApplyDirection = 'undo' | 'redo';

/** Options for multi-step timeline undo and redo. */
export interface MoveHistoryOptions {
   count?: number;
}

/** Raised when the exact source OID or index bytes no longer match. */
export class HistoryDivergenceError extends Error {
   readonly divergence: HistoryDivergence;

   constructor(divergence: HistoryDivergence) {
      super(`History ${divergence.direction} refused: repository ${divergence.surfaces.join(', ')} diverged.`);
      this.name = 'HistoryDivergenceError';
      this.divergence = divergence;
   }
}

/** Captures only the state named by an action-specific inverse plan. */
export async function beginHistoryTransaction(
   ctx: GdxContext,
   options: BeginHistoryTransactionOptions
): Promise<HistoryTransactionCapture> {
   const locations = ctx.repository
      ? createHistoryStoragePaths(ctx.repository)
      : await resolveHistoryStoragePaths(ctx.git$);
   const plan = options.capture ?? { kind: 'audit' };
   if (plan.kind === 'snapshot' && (await hasControlState(locations.gitDir))) {
      throw new Error('Cannot capture a replay snapshot while Git is in a control or sequencer state.');
   }
   return {
      ctx,
      id: createHistoryTransactionId(),
      root: locations.root,
      gitDir: locations.gitDir,
      historyDir: locations.historyDir,
      repository: {
         root: locations.root,
         gitDir: locations.gitDir,
         commonGitDir: locations.commonGitDir,
      },
      source: options.source ?? 'gdx',
      action: options.action,
      argv: [...options.argv],
      startedAt: options.startedAt ?? new Date().toISOString(),
      plan,
      before: await captureBoundary(ctx, locations.gitDir, plan),
   };
}

export const captureHistoryTransaction = beginHistoryTransaction;

/** Builds and records the smallest useful inverse after a successful mutation. */
export async function finalizeHistoryTransaction(
   capture: HistoryTransactionCapture,
   options: FinalizeHistoryTransactionOptions = {}
): Promise<HistoryTransactionManifest | HistoryTransactionInput | null> {
   try {
      const after = await captureBoundary(capture.ctx, capture.gitDir, capture.plan);
      const refs = changedRefs(capture.before.refs, after.refs);
      addHeadRefChange(refs, capture.before.head, after.head);
      const recipe = await buildRecipe(capture, after, refs);
      if (!recipe) {
         await removeCaptureArtifacts(capture);
         return null;
      }

      const command: HistoryCommandMetadata = {
         command: capture.action,
         argv: capture.argv,
         cwd: capture.root,
         startedAt: capture.startedAt,
         finishedAt: options.finishedAt ?? new Date().toISOString(),
         exitCode: options.exitCode ?? 0,
      };
      const input: HistoryTransactionInput = {
         id: capture.id,
         source: capture.source,
         command,
         capability: recipe.kind === 'raw-index' ? 'conditional' : 'exact',
         refs,
         fingerprints: recipeFingerprints(recipe),
         recipe,
      };
      if (options.record === false) return input;

      if (recipe.kind === 'snapshot') await anchorSnapshotTrees(capture.ctx, capture.id, recipe);
      return (
         await recordHistoryTransaction(capture.ctx.git$, input, {
            maxEntries: options.maxEntries,
            repository: capture.repository,
         })
      ).manifest;
   } catch (error) {
      await removeCaptureArtifacts(capture);
      throw error;
   }
}

/** Records a failed or incomplete snapshot attempt as audit evidence. */
async function recordSnapshotAudit(
   ctx: GdxContext,
   options: BeginHistoryTransactionOptions & Pick<FinalizeHistoryTransactionOptions, 'maxEntries'>,
   exitCode: number,
   finishedAt: string = new Date().toISOString(),
   capture?: HistoryTransactionCapture
): Promise<void> {
   if (options.capture?.kind !== 'snapshot' || !ctx.repository) return;
   const locations = createHistoryStoragePaths(ctx.repository);
   const startedAt = capture?.startedAt ?? options.startedAt ?? finishedAt;
   try {
      await recordHistoryTransaction(
         ctx.git$,
         {
            id: capture?.id,
            source: capture?.source ?? options.source ?? 'gdx',
            command: {
               command: options.action,
               argv: [...options.argv],
               cwd: capture?.root ?? locations.root,
               startedAt,
               finishedAt,
               exitCode,
            },
            capability: 'audit-only',
            refs: [],
            fingerprints: { before: emptyFingerprint(), after: emptyFingerprint() },
            undoUnavailableReason: 'Snapshot operation failed or left Git control state active.',
         },
         { maxEntries: options.maxEntries, repository: capture?.repository ?? locations }
      );
   } catch (error) {
      Logger.warn(`Failed to record snapshot audit: ${message(error)}`, 'history');
   }
}

/** Runs an operation with best-effort history that never blocks the operation itself. */
export async function runHistoryTransaction<T>(
   ctx: GdxContext,
   options: BeginHistoryTransactionOptions & Pick<FinalizeHistoryTransactionOptions, 'maxEntries'>,
   operation: () => Promise<T>
): Promise<T> {
   if (process.env.GDX_HISTORY_GUARD === '1') return await operation();
   let capture: HistoryTransactionCapture;
   try {
      capture = await beginHistoryTransaction(ctx, options);
   } catch (error) {
      Logger.warn(`History capture skipped: ${message(error)}`, 'history');
      try {
         const value = await operation();
         await recordSnapshotAudit(ctx, options, resultExitCode(value));
         return value;
      } catch (operationError) {
         await recordSnapshotAudit(ctx, options, errorExitCode(operationError));
         throw operationError;
      }
   }

   try {
      const value = await operation();
      const exitCode = resultExitCode(value);
      if (exitCode === 0 && !(capture.plan.kind === 'snapshot' && (await hasControlState(capture.gitDir)))) {
         await finalizeHistoryTransaction(capture, {
            exitCode,
            maxEntries: options.maxEntries,
         }).catch(async (error) => {
            await removeCaptureArtifacts(capture);
            await recordSnapshotAudit(ctx, options, exitCode, new Date().toISOString(), capture);
            Logger.warn(`History finalization skipped: ${message(error)}`, 'history');
         });
      } else {
         await removeCaptureArtifacts(capture);
         await recordSnapshotAudit(ctx, options, exitCode, new Date().toISOString(), capture);
      }
      return value;
   } catch (error) {
      await removeCaptureArtifacts(capture);
      await recordSnapshotAudit(ctx, options, errorExitCode(error), new Date().toISOString(), capture);
      throw error;
   }
}

export const runRoutedHistoryTransaction = runHistoryTransaction;

/** Applies one narrow inverse; every recipe checks its source boundary first. */
export async function applyHistoryTransaction(
   ctx: GdxContext,
   transaction: HistoryTransactionManifest,
   direction: HistoryApplyDirection
): Promise<void> {
   const recipe = transaction.recipe;
   if (!recipe) {
      if (!transaction.refs.length) throw new Error('This history entry has no inverse recipe.');
      await applyRefs(ctx, transaction, transaction.refs, direction);
      return;
   }
   if (recipe.kind === 'refs') return await applyRefs(ctx, transaction, recipe.changes, direction);
   if (recipe.kind === 'raw-index') return await applyRawIndex(ctx, transaction, recipe, direction);
   if (recipe.kind === 'snapshot') return await applySnapshot(ctx, transaction, recipe, direction);
   await applyHeadRecipe(ctx, transaction, recipe, direction);
}

/** Undoes entries and moves the cursor only after a complete recipe succeeds. */
export async function undoHistory(
   ctx: GdxContext,
   options: MoveHistoryOptions = {}
): Promise<HistoryTransactionManifest[]> {
   return await moveHistory(ctx, 'undo', options);
}

/** Redoes entries and moves the cursor only after a complete recipe succeeds. */
export async function redoHistory(
   ctx: GdxContext,
   options: MoveHistoryOptions = {}
): Promise<HistoryTransactionManifest[]> {
   return await moveHistory(ctx, 'redo', options);
}

/** Moves the journal cursor one successful recipe at a time. */
async function moveHistory(
   ctx: GdxContext,
   direction: HistoryApplyDirection,
   options: MoveHistoryOptions
): Promise<HistoryTransactionManifest[]> {
   const completed: HistoryTransactionManifest[] = [];
   const count = normalizeCount(options.count);
   while (completed.length < count) {
      const timeline = await readHistoryTimeline(ctx.git$, ctx.repository);
      const index = direction === 'undo' ? timeline.cursor - 1 : timeline.cursor;
      if (index < 0 || index >= timeline.entries.length) break;
      const manifest = await readHistoryTransactionManifest(
         ctx.git$,
         timeline.entries[index],
         ctx.repository
      );
      if (!manifest) throw new Error(`History manifest is missing: ${timeline.entries[index]}`);
      if (!canRestoreHistoryTransaction(manifest)) {
         await setHistoryCursor(
            ctx.git$,
            direction === 'undo' ? index : index + 1,
            ctx.repository
         );
         continue;
      }
      await applyHistoryTransaction(ctx, manifest, direction);
      await setHistoryCursor(
         ctx.git$,
         direction === 'undo' ? index : index + 1,
         ctx.repository
      );
      completed.push(manifest);
   }
   if (direction === 'redo' && completed.length > 0) await skipRedoAuditOnlyTail(ctx);
   return completed;
}

/** Advances redo past adjacent audit-only entries whose effects were never undone. */
async function skipRedoAuditOnlyTail(ctx: GdxContext): Promise<void> {
   while (true) {
      const timeline = await readHistoryTimeline(ctx.git$, ctx.repository);
      const id = timeline.entries[timeline.cursor];
      if (!id) return;
      const manifest = await readHistoryTransactionManifest(ctx.git$, id, ctx.repository);
      if (!manifest) throw new Error(`History manifest is missing: ${id}`);
      if (canRestoreHistoryTransaction(manifest)) return;
      await setHistoryCursor(ctx.git$, timeline.cursor + 1, ctx.repository);
   }
}

/** Returns whether a transaction has a restoration recipe the engine can apply. */
function canRestoreHistoryTransaction(manifest: HistoryTransactionManifest): boolean {
   return manifest.capability !== 'audit-only' && !manifest.undoUnavailableReason;
}

/**
 * Discards restorable timeline entries whose recorded Git objects were pruned
 * (for example by `git gc` after reflog expiry), since neither undo nor redo
 * can succeed for them. Inspection failures never discard anything.
 * @param ctx - GDX execution context.
 * @returns IDs of the discarded transactions.
 */
export async function discardUnreachableHistory(
   ctx: GdxContext
): Promise<HistoryTransactionId[]> {
   const manifests = await listHistoryTransactions(ctx.git$, ctx.repository);
   const oidsById = new Map<HistoryTransactionId, string[]>();
   for (const manifest of manifests) {
      const oids = recipeObjectIds(manifest);
      if (oids.length) oidsById.set(manifest.id, oids);
   }
   if (!oidsById.size) return [];

   const unique = [...new Set([...oidsById.values()].flat())];
   const result = await runGit(
      ctx,
      ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
      true,
      `${unique.join('\n')}\n`
   );
   if (result.exitCode !== 0) return [];
   const missing = new Set(
      text(result.stdout)
         .split('\n')
         .filter((line) => line.endsWith(' missing'))
         .map((line) => line.slice(0, -' missing'.length))
   );
   if (!missing.size) return [];

   const unreachable = [...oidsById]
      .filter(([, oids]) => oids.some((oid) => missing.has(oid)))
      .map(([id]) => id);
   if (unreachable.length) {
      await removeHistoryTransactions(ctx.git$, unreachable, ctx.repository);
   }
   return unreachable;
}

/** Lists the Git objects a restorable entry needs for both undo and redo. */
function recipeObjectIds(manifest: HistoryTransactionManifest): string[] {
   if (!canRestoreHistoryTransaction(manifest)) return [];
   const recipe = manifest.recipe;
   if (!recipe) return refChangeOids(manifest.refs);
   if (recipe.kind === 'refs') return refChangeOids(recipe.changes);
   if (recipe.kind === 'head-soft' || recipe.kind === 'switch') {
      return [recipe.before, recipe.after].flatMap((state) => {
         const oid = refOid(state.value);
         return oid ? [oid] : [];
      });
   }
   if (recipe.kind === 'snapshot') {
      return [
         recipe.before.worktreeTree,
         recipe.after.worktreeTree,
         recipe.before.indexTree,
         recipe.after.indexTree,
         ...refChangeOids(recipe.refs),
         ...[recipe.before.head, recipe.after.head].flatMap((head) => {
            const oid = refOid(head.value);
            return oid ? [oid] : [];
         }),
      ];
   }
   return []; // raw-index recipes use local artifacts validated at apply time.
}

/** Collects the concrete boundary OIDs of a ref-change list. */
function refChangeOids(changes: readonly HistoryRefChange[]): string[] {
   return changes.flatMap((change) =>
      [change.before, change.after].flatMap((state) => {
         const oid = refOid(state);
         return oid ? [oid] : [];
      })
   );
}

/** Captures HEAD, named refs, or raw index bytes according to the selected recipe. */
async function captureBoundary(
   ctx: GdxContext,
   gitDir: string,
   plan: ReversibleCapturePlan
): Promise<Boundary> {
   const headPromise = plan.kind === 'head-soft' || plan.kind === 'switch' || plan.kind === 'snapshot'
      ? captureHead(ctx)
      : Promise.resolve(undefined);
   const refsPromise = plan.kind === 'refs'
      ? captureRefs(ctx, plan.refs)
      : plan.kind === 'snapshot'
         ? captureAllRefs(ctx)
      : Promise.resolve(new Map<string, HistoryRefState>());
   const indexPromise = plan.kind === 'raw-index' || plan.kind === 'snapshot'
      ? readOptional(path.join(gitDir, 'index'))
      : Promise.resolve(undefined);
   const indexTreePromise = plan.kind === 'snapshot'
      ? captureIndexTree(ctx, gitDir)
      : Promise.resolve(undefined);
   const indexSemanticPromise = plan.kind === 'snapshot'
      ? captureIndexSemanticFingerprint(ctx, gitDir)
      : Promise.resolve(undefined);
   const worktreePromise = plan.kind === 'snapshot' ? captureWorktreeTree(ctx, gitDir) : Promise.resolve(undefined);
   const [head, refs, index, indexTree, indexSemanticFingerprint, worktreeTree] = await Promise.all([
      headPromise,
      refsPromise,
      indexPromise,
      indexTreePromise,
      indexSemanticPromise,
      worktreePromise,
   ]);
   return { head, refs, index, indexTree, indexSemanticFingerprint, worktreeTree };
}

/** Reads symbolic and resolved HEAD without enumerating repository refs. */
async function captureHead(ctx: GdxContext): Promise<HistoryHeadState> {
   const [symbolic, oid] = await Promise.all([
      runGit(ctx, ['symbolic-ref', '-q', 'HEAD'], true),
      runGit(ctx, ['rev-parse', '--verify', 'HEAD'], true),
   ]);
   const target = text(symbolic.stdout);
   const resolved = text(oid.stdout);
   if (target) return { value: { kind: 'symbolic', target, oid: resolved || null }, unborn: !resolved };
   if (resolved) return { value: { kind: 'oid', oid: resolved }, unborn: false };
   return { value: { kind: 'missing' }, unborn: true };
}

/** Reads only refs identified by the command line. */
async function captureRefs(
   ctx: GdxContext,
   names: readonly string[]
): Promise<Map<string, HistoryRefState>> {
   const values = await Promise.all(names.map(async (name) => {
      const result = name.startsWith('refs/')
         ? await runGit(ctx, ['show-ref', '--verify', '--hash', name], true)
         : await runGit(ctx, ['rev-parse', '--verify', name], true);
      const state: HistoryRefState = result.exitCode === 0
         ? { kind: 'oid', oid: text(result.stdout) }
         : { kind: 'missing' };
      return [name, state] as const;
   }));
   return new Map(values);
}

/** Reads all persistent refs so replay-style commands can restore update-refs safely. */
async function captureAllRefs(ctx: GdxContext): Promise<Map<string, HistoryRefState>> {
   const result = await runGit(ctx, ['for-each-ref', '--format=%(refname)\t%(objectname)'], false);
   const refs = new Map<string, HistoryRefState>();
   for (const line of text(result.stdout).split('\n')) {
      const separator = line.indexOf('\t');
      if (separator <= 0) continue;
      const name = line.slice(0, separator);
      if (name.startsWith('refs/gdx/')) continue;
      const oid = line.slice(separator + 1);
      if (oid) refs.set(name, { kind: 'oid', oid });
   }
   const originalHead = await runGit(ctx, ['rev-parse', '--verify', 'ORIG_HEAD'], true);
   const originalHeadOid = text(originalHead.stdout);
   if (originalHead.exitCode === 0 && originalHeadOid) {
      refs.set('ORIG_HEAD', { kind: 'oid', oid: originalHeadOid });
   }
   return refs;
}

/** Materializes the tracked worktree as a content-addressed tree without touching the real index. */
async function captureWorktreeTree(ctx: GdxContext, gitDir: string): Promise<string> {
   const temporaryIndex = path.join(gitDir, `gdx-history-index-${crypto.randomUUID()}`);
   const indexPath = path.join(gitDir, 'index');
   try {
      const index = await readOptional(indexPath);
      if (index) await fs.writeFile(temporaryIndex, index);
      else {
         const empty = await runGit(
            ctx,
            ['read-tree', '--empty'],
            true,
            undefined,
            undefined,
            { GIT_INDEX_FILE: temporaryIndex }
         );
         if (empty.exitCode !== 0) throw new Error(`git read-tree failed: ${text(empty.stderr)}`);
      }
      const added = await runGit(
         ctx,
         ['add', '-u', '--'],
         true,
         undefined,
         undefined,
         { GIT_INDEX_FILE: temporaryIndex }
      );
      if (added.exitCode !== 0) throw new Error(`git add failed: ${text(added.stderr)}`);
      const tree = await runGit(
         ctx,
         ['write-tree'],
         false,
         undefined,
         undefined,
         { GIT_INDEX_FILE: temporaryIndex }
      );
      const oid = text(tree.stdout);
      if (!oid) throw new Error('git write-tree returned no tree object.');
      return oid;
   } finally {
      await fs.rm(temporaryIndex, { force: true });
      await fs.rm(`${temporaryIndex}.lock`, { force: true });
   }
}

/** Captures the staged index as a tree while ignoring filesystem stat-cache metadata. */
async function captureIndexTree(ctx: GdxContext, gitDir: string): Promise<string> {
   const temporaryIndex = path.join(gitDir, `gdx-history-index-tree-${crypto.randomUUID()}`);
   const indexPath = path.join(gitDir, 'index');
   try {
      const index = await readOptional(indexPath);
      if (index) await fs.writeFile(temporaryIndex, index);
      else {
         const empty = await runGit(
            ctx,
            ['read-tree', '--empty'],
            true,
            undefined,
            undefined,
            { GIT_INDEX_FILE: temporaryIndex }
         );
         if (empty.exitCode !== 0) throw new Error(`git read-tree failed: ${text(empty.stderr)}`);
      }
      const tree = await runGit(ctx, ['write-tree'], false, undefined, undefined, {
         GIT_INDEX_FILE: temporaryIndex,
      });
      const oid = text(tree.stdout);
      if (!oid) throw new Error('git write-tree returned no index tree object.');
      return oid;
   } finally {
      await fs.rm(temporaryIndex, { force: true });
      await fs.rm(`${temporaryIndex}.lock`, { force: true });
   }
}

/** Captures semantic index entries and flags while ignoring stat-cache metadata. */
async function captureIndexSemanticFingerprint(ctx: GdxContext, gitDir: string): Promise<string> {
   const temporaryIndex = path.join(gitDir, `gdx-history-index-semantic-${crypto.randomUUID()}`);
   const indexPath = path.join(gitDir, 'index');
   try {
      const index = await readOptional(indexPath);
      return await captureIndexSemanticFromBytes(ctx, temporaryIndex, index);
   } finally {
      await fs.rm(temporaryIndex, { force: true });
      await fs.rm(`${temporaryIndex}.lock`, { force: true });
   }
}

/** Computes the semantic fingerprint of an index artifact in an isolated temporary index. */
async function captureIndexSemanticFromBytes(
   ctx: GdxContext,
   temporaryIndex: string,
   index: Buffer | null
): Promise<string> {
   if (index) await fs.writeFile(temporaryIndex, index);
   else {
      const empty = await runGit(
         ctx,
         ['read-tree', '--empty'],
         true,
         undefined,
         undefined,
         { GIT_INDEX_FILE: temporaryIndex }
      );
      if (empty.exitCode !== 0) throw new Error(`git read-tree failed: ${text(empty.stderr)}`);
   }
   return await readIndexSemanticFingerprint(ctx, temporaryIndex);
}

/** Hashes index entries and semantic flags, with NUL-safe Git output. */
async function readIndexSemanticFingerprint(ctx: GdxContext, indexFile: string): Promise<string> {
   const [entries, flags] = await Promise.all([
      runGit(
         ctx,
         ['ls-files', '--stage', '-z'],
         false,
         undefined,
         undefined,
         { GIT_INDEX_FILE: indexFile }
      ),
      runGit(
         ctx,
         ['ls-files', '-v', '-z'],
         false,
         undefined,
         undefined,
         { GIT_INDEX_FILE: indexFile }
      ),
   ]);
   if (entries.exitCode !== 0 || flags.exitCode !== 0) {
      throw new Error(`git ls-files failed while capturing the semantic index fingerprint.`);
   }
   const separator = Buffer.from([0]);
   return checksum(Buffer.concat([entries.stdout, separator, flags.stdout]));
}

/** Computes a semantic fingerprint for a persisted index artifact before restoration. */
async function semanticFingerprintForArtifact(
   ctx: GdxContext,
   gitDir: string,
   index: Buffer | null
): Promise<string> {
   const temporaryIndex = path.join(gitDir, `gdx-history-index-verify-${crypto.randomUUID()}`);
   try {
      return await captureIndexSemanticFromBytes(ctx, temporaryIndex, index);
   } finally {
      await fs.rm(temporaryIndex, { force: true });
      await fs.rm(`${temporaryIndex}.lock`, { force: true });
   }
}

/** Chooses one persisted inverse from the state actually changed. */
async function buildRecipe(
   capture: HistoryTransactionCapture,
   after: Boundary,
   refs: HistoryRefChange[]
): Promise<HistoryInverseRecipe | null> {
   if (capture.plan.kind === 'refs') return refs.length ? { kind: 'refs', changes: refs } : null;
   if (capture.plan.kind === 'head-soft' || capture.plan.kind === 'switch') {
      if (!capture.before.head || !after.head || equalHead(capture.before.head, after.head)) return null;
      return { kind: capture.plan.kind, before: capture.before.head, after: after.head };
   }
   if (capture.plan.kind === 'snapshot') {
      if (
         !capture.before.head ||
         !after.head ||
         !capture.before.indexTree ||
         !after.indexTree ||
         !capture.before.indexSemanticFingerprint ||
         !after.indexSemanticFingerprint ||
         !capture.before.worktreeTree ||
         !after.worktreeTree
      ) return null;
      const beforeIndex = capture.before.index;
      const afterIndex = after.index;
      const beforeState: HistorySnapshotState = {
         head: capture.before.head,
         index: beforeIndex ? await persistIndex(capture, 'before', beforeIndex) : null,
         indexTree: capture.before.indexTree,
         indexSemanticFingerprint: capture.before.indexSemanticFingerprint,
         indexChecksum: checksum(beforeIndex ?? null),
         worktreeTree: capture.before.worktreeTree,
      };
      const afterState: HistorySnapshotState = {
         head: after.head,
         index: afterIndex ? await persistIndex(capture, 'after', afterIndex) : null,
         indexTree: after.indexTree,
         indexSemanticFingerprint: after.indexSemanticFingerprint,
         indexChecksum: checksum(afterIndex ?? null),
         worktreeTree: after.worktreeTree,
      };
      if (
         equalHead(beforeState.head, afterState.head) &&
         beforeState.indexTree === afterState.indexTree &&
         beforeState.indexSemanticFingerprint === afterState.indexSemanticFingerprint &&
         beforeState.indexChecksum === afterState.indexChecksum &&
         beforeState.worktreeTree === afterState.worktreeTree &&
         refs.length === 0
      ) {
         return null;
      }
      return { kind: 'snapshot', before: beforeState, after: afterState, refs };
   }
   if (capture.plan.kind === 'raw-index') {
      const before = capture.before.index;
      const next = after.index;
      if (before === undefined || next === undefined || sameBytes(before, next)) return null;
      return {
         kind: 'raw-index',
         before: await persistIndex(capture, 'before', before),
         after: capture.plan.redo ? await persistIndex(capture, 'after', next) : null,
         beforeChecksum: checksum(before),
         afterChecksum: checksum(next),
      };
   }
   return null;
}

/** Persists one raw index file; null denotes an absent index. */
async function persistIndex(
   capture: HistoryTransactionCapture,
   side: string,
   bytes: Buffer | null
): Promise<HistoryArtifactReference | null> {
   if (bytes === null) return null;
   const relative = path.join('artifacts', capture.id, `${side}.index`).replaceAll('\\', '/');
   const absolute = path.join(capture.historyDir, ...relative.split('/'));
   await fs.mkdir(path.dirname(absolute), { recursive: true });
   await fs.writeFile(absolute, bytes);
   return { path: relative, size: bytes.length, fingerprint: { algorithm: 'sha256', value: checksum(bytes) } };
}

/** Applies a soft HEAD move or a normal Git switch after matching current HEAD. */
async function applyHeadRecipe(
   ctx: GdxContext,
   transaction: HistoryTransactionManifest,
   recipe: Extract<HistoryInverseRecipe, { kind: 'head-soft' | 'switch' }>,
   direction: HistoryApplyDirection
): Promise<void> {
   const source = direction === 'undo' ? recipe.after : recipe.before;
   const target = direction === 'undo' ? recipe.before : recipe.after;
   const current = await captureHead(ctx);
   if (!equalHead(current, source)) throw divergence(transaction, direction, 'head');
   if (target.value.kind === 'missing') throw new Error('Cannot restore a missing HEAD.');
   if (recipe.kind === 'head-soft') {
      const oid = refOid(target.value);
      if (!oid) throw new Error('History target HEAD is unavailable.');
      await runGit(ctx, ['reset', '--soft', oid], false, undefined, `gdx history ${direction}`);
      return;
   }
   if (target.value.kind === 'symbolic' && target.value.target.startsWith('refs/heads/')) {
      const targetOid = refOid(target.value);
      const actual = await runGit(ctx, ['show-ref', '--verify', '--hash', target.value.target], true);
      if (!targetOid || text(actual.stdout) !== targetOid) {
         throw divergence(transaction, direction, 'head');
      }
      await runGit(ctx, ['switch', target.value.target.slice('refs/heads/'.length)]);
   } else {
      const oid = refOid(target.value);
      if (!oid) throw new Error('History target HEAD is unavailable.');
      await runGit(ctx, ['switch', '--detach', oid]);
   }
}

/** Applies named direct refs atomically with expected-old OIDs. */
async function applyRefs(
   ctx: GdxContext,
   transaction: HistoryTransactionManifest,
   changes: HistoryRefChange[],
   direction: HistoryApplyDirection
): Promise<void> {
   const sourceSide = direction === 'undo' ? 'after' : 'before';
   const targetSide = direction === 'undo' ? 'before' : 'after';
   const commands = ['start'];
   for (const change of changes) {
      const source = change[sourceSide];
      const target = change[targetSide];
      if (source.kind === 'symbolic' || target.kind === 'symbolic') {
         throw new Error('Symbolic ref recipes are not supported.');
      }
      if (source.kind === 'missing' && target.kind === 'oid') commands.push(`create ${change.name} ${target.oid}`);
      else if (source.kind === 'oid' && target.kind === 'missing') commands.push(`delete ${change.name} ${source.oid}`);
      else if (source.kind === 'oid' && target.kind === 'oid') commands.push(`update ${change.name} ${target.oid} ${source.oid}`);
   }
   commands.push('prepare', 'commit', '');
   const result = await runGit(
      ctx,
      ['update-ref', '-m', `gdx history ${direction} ${transaction.id}`, '--stdin'],
      true,
      commands.join('\n')
   );
   if (result.exitCode !== 0) throw divergence(transaction, direction, 'refs');
}

/** Restores raw index bytes after a checksum precondition; redo is deliberately optional. */
async function applyRawIndex(
   ctx: GdxContext,
   transaction: HistoryTransactionManifest,
   recipe: Extract<HistoryInverseRecipe, { kind: 'raw-index' }>,
   direction: HistoryApplyDirection
): Promise<void> {
   const paths = ctx.repository
      ? createHistoryStoragePaths(ctx.repository)
      : await resolveHistoryStoragePaths(ctx.git$);
   const indexPath = path.join(paths.gitDir, 'index');
   const current = await readOptional(indexPath);
   const expected = direction === 'undo' ? recipe.afterChecksum : recipe.beforeChecksum;
   if (checksum(current) !== expected) throw divergence(transaction, direction, 'index');
   const artifact = direction === 'undo' ? recipe.before : recipe.after;
   if (direction === 'redo' && recipe.after === null && recipe.afterChecksum !== checksum(null)) {
      throw new Error('Redo is unavailable for this index transaction.');
   }
   if (!artifact) {
      await fs.rm(indexPath, { force: true });
      return;
   }
   const artifactPath = path.join(paths.historyDir, ...artifact.path.split('/'));
   const bytes = await fs.readFile(artifactPath);
   if (checksum(bytes) !== artifact.fingerprint.value) throw new Error('History index artifact is missing or corrupt.');
   await atomicWrite(indexPath, bytes);
}

/** Applies a complete tracked-state snapshot while preserving unrelated untracked files. */
async function applySnapshot(
   ctx: GdxContext,
   transaction: HistoryTransactionManifest,
   recipe: Extract<HistoryInverseRecipe, { kind: 'snapshot' }>,
   direction: HistoryApplyDirection
): Promise<void> {
   const source = direction === 'undo' ? recipe.after : recipe.before;
   const target = direction === 'undo' ? recipe.before : recipe.after;
   const currentPaths = ctx.repository
      ? createHistoryStoragePaths(ctx.repository)
      : await resolveHistoryStoragePaths(ctx.git$);
   const current = await captureBoundary(ctx, currentPaths.gitDir, { kind: 'snapshot' });
   if (
      !current.head ||
      !current.indexTree ||
      !current.indexSemanticFingerprint ||
      !current.worktreeTree ||
      !equalHead(current.head, source.head)
   ) {
      throw divergence(transaction, direction, 'head');
   }
   if (current.worktreeTree !== source.worktreeTree) throw divergence(transaction, direction, 'paths');
   if (
      current.indexTree !== source.indexTree ||
      current.indexSemanticFingerprint !== source.indexSemanticFingerprint
   ) {
      throw divergence(transaction, direction, 'index');
   }
   const sourceRefs = new Map(recipe.refs.map((change) => [
      change.name,
      direction === 'undo' ? change.after : change.before,
   ]));
   const currentRefs = await captureRefs(ctx, [...sourceRefs.keys()]);
   for (const [name, expected] of sourceRefs) {
      if (JSON.stringify(currentRefs.get(name) ?? { kind: 'missing' }) !== JSON.stringify(expected)) {
         throw divergence(transaction, direction, 'refs');
      }
   }

   const paths = currentPaths;
   if (await hasControlState(paths.gitDir)) throw new Error('Cannot restore a snapshot during a Git control operation.');
   const targetIndex = target.index
      ? await readHistoryArtifact(paths.historyDir, transaction.id, target.index)
      : null;
   if (checksum(targetIndex) !== target.indexChecksum) {
      throw new Error('History index artifact is missing or corrupt.');
   }
   await assertTree(ctx, source.worktreeTree);
   await assertTree(ctx, target.worktreeTree);
   await assertHeadObject(ctx, target.head);
   for (const change of recipe.refs) {
      const targetRef = direction === 'undo' ? change.before : change.after;
      await assertRefObject(ctx, targetRef);
   }

   const sourceIndex = source.index
      ? await readHistoryArtifact(paths.historyDir, transaction.id, source.index)
      : null;
   if (checksum(sourceIndex) !== source.indexChecksum) {
      throw new Error('History index artifact is missing or corrupt.');
   }
   const targetSemantic = await semanticFingerprintForArtifact(ctx, paths.gitDir, targetIndex);
   const sourceSemantic = await semanticFingerprintForArtifact(ctx, paths.gitDir, sourceIndex);
   if (
      targetSemantic !== target.indexSemanticFingerprint ||
      sourceSemantic !== source.indexSemanticFingerprint
   ) {
      throw new Error('History semantic index fingerprint does not match its artifact.');
   }

   await updateTrackedWorktree(ctx, paths.gitDir, source.worktreeTree, target.worktreeTree);
   if (targetIndex === null) await fs.rm(path.join(paths.gitDir, 'index'), { force: true });
   else await atomicWrite(path.join(paths.gitDir, 'index'), targetIndex);

   try {
      await applyRefs(ctx, transaction, recipe.refs, direction);
      await applyHeadState(ctx, source.head, target.head);
   } catch (error) {
      await updateTrackedWorktree(ctx, paths.gitDir, target.worktreeTree, source.worktreeTree).catch(() => undefined);
      if (sourceIndex === null) await fs.rm(path.join(paths.gitDir, 'index'), { force: true });
      else await atomicWrite(path.join(paths.gitDir, 'index'), sourceIndex).catch(() => undefined);
      await applyHeadState(ctx, target.head, source.head).catch(() => undefined);
      await applyRefs(ctx, transaction, recipe.refs, direction === 'undo' ? 'redo' : 'undo').catch(() => undefined);
      throw error;
   }
}

/** Restores tracked files with a temporary index, allowing Git to reject untracked collisions. */
async function updateTrackedWorktree(
   ctx: GdxContext,
   gitDir: string,
   sourceTree: string,
   targetTree: string
): Promise<void> {
   const temporaryIndex = path.join(gitDir, `gdx-history-restore-${crypto.randomUUID()}`);
   try {
      await runGit(
         ctx,
         ['read-tree', sourceTree],
         false,
         undefined,
         undefined,
         { GIT_INDEX_FILE: temporaryIndex }
      );
      await runGit(
         ctx,
         ['update-index', '--refresh'],
         false,
         undefined,
         undefined,
         { GIT_INDEX_FILE: temporaryIndex }
      );
      await runGit(
         ctx,
         ['read-tree', '-m', '-u', sourceTree, targetTree],
         false,
         undefined,
         undefined,
         { GIT_INDEX_FILE: temporaryIndex }
      );
   } finally {
      await fs.rm(temporaryIndex, { force: true });
      await fs.rm(`${temporaryIndex}.lock`, { force: true });
   }
}

/** Checks that a snapshot tree still exists before any working-tree mutation. */
async function assertTree(ctx: GdxContext, tree: string): Promise<void> {
   const result = await runGit(ctx, ['cat-file', '-e', `${tree}^{tree}`], true);
   if (result.exitCode !== 0) throw new Error(`History snapshot tree is unavailable: ${tree}`);
}

/** Checks that a direct or symbolic HEAD target still resolves before mutation. */
async function assertHeadObject(ctx: GdxContext, head: HistoryHeadState): Promise<void> {
   const oid = refOid(head.value);
   if (!oid) return;
   const result = await runGit(ctx, ['cat-file', '-e', `${oid}^{commit}`], true);
   if (result.exitCode !== 0) throw new Error(`History HEAD object is unavailable: ${oid}`);
}

/** Checks that a ref target object still exists before mutation. */
async function assertRefObject(ctx: GdxContext, state: HistoryRefState): Promise<void> {
   const oid = refOid(state);
   if (!oid) return;
   const result = await runGit(ctx, ['cat-file', '-e', oid], true);
   if (result.exitCode !== 0) throw new Error(`History ref object is unavailable: ${oid}`);
}

/** Applies the symbolic or detached HEAD boundary without touching the restored index/worktree. */
async function applyHeadState(
   ctx: GdxContext,
   source: HistoryHeadState,
   target: HistoryHeadState
): Promise<void> {
   if (target.value.kind === 'missing') throw new Error('Cannot restore a missing HEAD.');
   if (target.value.kind === 'symbolic') {
      await runGit(ctx, ['symbolic-ref', 'HEAD', target.value.target]);
      return;
   }
   const expected = refOid(source.value);
   const args = ['update-ref', '--no-deref', 'HEAD', target.value.oid];
   if (expected) args.push(expected);
   await runGit(ctx, args);
}

/** Returns action-specific boundary fingerprints without recapturing generic surfaces. */
function recipeFingerprints(recipe: HistoryInverseRecipe) {
   const before = emptyFingerprint();
   const after = emptyFingerprint();
   if (recipe.kind === 'head-soft' || recipe.kind === 'switch') {
      before.head = tokenFingerprint(recipe.before);
      after.head = tokenFingerprint(recipe.after);
   } else if (recipe.kind === 'refs') {
      before.refs = tokenFingerprint(recipe.changes.map((change) => [change.name, change.before]));
      after.refs = tokenFingerprint(recipe.changes.map((change) => [change.name, change.after]));
   } else if (recipe.kind === 'snapshot') {
      before.refs = tokenFingerprint(recipe.refs.map((change) => [change.name, change.before]));
      after.refs = tokenFingerprint(recipe.refs.map((change) => [change.name, change.after]));
      before.head = tokenFingerprint(recipe.before.head);
      after.head = tokenFingerprint(recipe.after.head);
      before.index = { algorithm: 'sha256', value: recipe.before.indexSemanticFingerprint };
      after.index = { algorithm: 'sha256', value: recipe.after.indexSemanticFingerprint };
      before.paths = { algorithm: 'git-oid', value: recipe.before.worktreeTree };
      after.paths = { algorithm: 'git-oid', value: recipe.after.worktreeTree };
   } else {
      before.index = { algorithm: 'sha256', value: recipe.beforeChecksum };
      after.index = { algorithm: 'sha256', value: recipe.afterChecksum };
   }
   before.combined = tokenFingerprint(before);
   after.combined = tokenFingerprint(after);
   return { before, after };
}

/** Creates a neutral legacy fingerprint shape required by journal schema v1. */
function emptyFingerprint(): HistoryRepositoryFingerprint {
   const blank = { algorithm: 'sha256' as const, value: '' };
   return { refs: blank, head: blank, index: blank, paths: blank, control: blank, combined: blank };
}

/** Lists only refs present in the narrow capture plan that actually changed. */
function changedRefs(before: Map<string, HistoryRefState>, after: Map<string, HistoryRefState>): HistoryRefChange[] {
   const names = new Set([...before.keys(), ...after.keys()]);
   return [...names].flatMap((name) => {
      const oldValue = before.get(name) ?? { kind: 'missing' as const };
      const newValue = after.get(name) ?? { kind: 'missing' as const };
      return JSON.stringify(oldValue) === JSON.stringify(newValue) ? [] : [{ name, before: oldValue, after: newValue }];
   });
}

/** Adds the symbolic branch transition so observer reconciliation can identify routed commits. */
function addHeadRefChange(
   refs: HistoryRefChange[],
   before: HistoryHeadState | undefined,
   after: HistoryHeadState | undefined
): void {
   if (!before || !after || before.value.kind !== 'symbolic' || after.value.kind !== 'symbolic') return;
   const beforeValue = before.value;
   const afterValue = after.value;
   if (beforeValue.target !== afterValue.target || beforeValue.oid === afterValue.oid) return;
   if (refs.some((change) => change.name === beforeValue.target)) return;
   refs.push({
      name: beforeValue.target,
      before: beforeValue.oid ? { kind: 'oid', oid: beforeValue.oid } : { kind: 'missing' },
      after: afterValue.oid ? { kind: 'oid', oid: afterValue.oid } : { kind: 'missing' },
   });
}

/** Executes Git with the history recursion guard and binary-safe output. */
async function runGit(
   ctx: GdxContext,
   args: readonly string[],
   allowFailure = false,
   input?: Uint8Array | string,
   reflogAction?: string,
   extraEnv?: Record<string, string>
): Promise<GitResult> {
   const command = Array.isArray(ctx.git$) ? ctx.git$ : [ctx.git$];
   const result = await execa(command[0], [...command.slice(1), ...args], {
      env: reflogAction
         ? { ...HISTORY_GIT_CHILD_ENV, GIT_REFLOG_ACTION: reflogAction, ...extraEnv }
         : { ...HISTORY_GIT_CHILD_ENV, ...extraEnv },
      encoding: 'base64',
      input,
      reject: false,
      stripFinalNewline: false,
   });
   const output = {
      stdout: Buffer.from(result.stdout || '', 'base64'),
      stderr: Buffer.from(result.stderr || '', 'base64'),
      exitCode: result.exitCode ?? 1,
   };
   if (!allowFailure && output.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${text(output.stderr)}`);
   return output;
}

/** Creates the public divergence shape while protecting only one narrow surface. */
function divergence(
   transaction: HistoryTransactionManifest,
   direction: HistoryApplyDirection,
   surface: keyof HistoryRepositoryFingerprint
): HistoryDivergenceError {
   return new HistoryDivergenceError({
      transaction,
      direction,
      surfaces: [surface],
      expected: transaction.fingerprints[direction === 'undo' ? 'after' : 'before'],
      actual: emptyFingerprint(),
   });
}

/** Reads a file while preserving absence as a distinct state. */
async function readOptional(filePath: string): Promise<Buffer | null> {
   try {
      return await fs.readFile(filePath);
   } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
   }
}

/** Reads and verifies a transaction-local artifact before it can affect repository state. */
async function readHistoryArtifact(
   historyDir: string,
   transactionId: string,
   artifact: HistoryArtifactReference
): Promise<Buffer> {
   const root = path.resolve(historyDir, 'artifacts', transactionId);
   const artifactPath = path.resolve(historyDir, ...artifact.path.split('/'));
   if (artifactPath !== root && !artifactPath.startsWith(`${root}${path.sep}`)) {
      throw new Error('History artifact path escapes the history directory.');
   }
   const bytes = await fs.readFile(artifactPath);
   if (bytes.length !== artifact.size || checksum(bytes) !== artifact.fingerprint.value) {
      throw new Error('History index artifact is missing or corrupt.');
   }
   return bytes;
}

/** Detects Git sequencer/control files that this snapshot recipe does not restore. */
async function hasControlState(gitDir: string): Promise<boolean> {
   const markers = [
      'MERGE_HEAD',
      'CHERRY_PICK_HEAD',
      'REVERT_HEAD',
      'BISECT_LOG',
      'rebase-apply',
      'rebase-merge',
      'sequencer',
   ];
   return (await Promise.all(markers.map(async (marker) => {
      try {
         await fs.stat(path.join(gitDir, marker));
         return true;
      } catch (error) {
         if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
         throw error;
      }
   }))).some(Boolean);
}

/** Removes pre-command artifacts when a routed operation fails or is not safely restorable. */
async function removeCaptureArtifacts(capture: HistoryTransactionCapture): Promise<void> {
   await removeSnapshotAnchors(capture.ctx, capture.id);
   await fs.rm(path.join(capture.historyDir, 'artifacts', capture.id), {
      recursive: true,
      force: true,
   });
}

/** Returns the two private refs that keep snapshot trees reachable. */
function snapshotAnchorRefs(
   id: string,
   recipe?: Extract<HistoryInverseRecipe, { kind: 'snapshot' }>
): string[] {
   const refs = [
      `${HISTORY_SNAPSHOT_REF_PREFIX}${id}/before`,
      `${HISTORY_SNAPSHOT_REF_PREFIX}${id}/after`,
      `${HISTORY_SNAPSHOT_REF_PREFIX}${id}/index-before`,
      `${HISTORY_SNAPSHOT_REF_PREFIX}${id}/index-after`,
      `${HISTORY_SNAPSHOT_REF_PREFIX}${id}/head-before`,
      `${HISTORY_SNAPSHOT_REF_PREFIX}${id}/head-after`,
   ];
   if (!recipe) return refs;
   recipe.refs.forEach((_, index) => {
      refs.push(
         `${HISTORY_SNAPSHOT_REF_PREFIX}${id}/ref-before-${index}`,
         `${HISTORY_SNAPSHOT_REF_PREFIX}${id}/ref-after-${index}`
      );
   });
   return refs;
}

/** Anchors snapshot trees until their transaction manifest is removed. */
async function anchorSnapshotTrees(
   ctx: GdxContext,
   id: string,
   recipe: Extract<HistoryInverseRecipe, { kind: 'snapshot' }>
): Promise<void> {
   const [before, after, indexBefore, indexAfter, headBefore, headAfter, ...refAnchors] = snapshotAnchorRefs(id, recipe);
   const updates = [
      `update ${before} ${recipe.before.worktreeTree}`,
      `update ${after} ${recipe.after.worktreeTree}`,
      `update ${indexBefore} ${recipe.before.indexTree}`,
      `update ${indexAfter} ${recipe.after.indexTree}`,
   ];
   const beforeHead = refOid(recipe.before.head.value);
   const afterHead = refOid(recipe.after.head.value);
   if (beforeHead) updates.push(`update ${headBefore} ${beforeHead}`);
   if (afterHead) updates.push(`update ${headAfter} ${afterHead}`);
   recipe.refs.forEach((change, index) => {
      const beforeOid = refOid(change.before);
      const afterOid = refOid(change.after);
      if (beforeOid) updates.push(`update ${refAnchors[index * 2]} ${beforeOid}`);
      if (afterOid) updates.push(`update ${refAnchors[index * 2 + 1]} ${afterOid}`);
   });
   await runGit(
      ctx,
      ['update-ref', '--stdin'],
      false,
      `${updates.join('\n')}\n`,
      `gdx history snapshot ${id}`
   );
}

/** Removes snapshot reachability anchors after retention or failed recording. */
async function removeSnapshotAnchors(
   ctx: GdxContext,
   id: string
): Promise<void> {
   const prefix = `${HISTORY_SNAPSHOT_REF_PREFIX}${id}/`;
   const listed = await runGit(ctx, ['for-each-ref', '--format=%(refname)', prefix]);
   const refs = text(listed.stdout).split('\n').filter((ref) => ref.startsWith(prefix));
   if (!refs.length) return;
   await runGit(
      ctx,
      ['update-ref', '--stdin'],
      false,
      `${refs.map((ref) => `delete ${ref}`).join('\n')}\n`,
      `gdx history snapshot cleanup ${id}`
   );
}

/** Atomically replaces the index in its own directory. */
async function atomicWrite(filePath: string, bytes: Buffer): Promise<void> {
   const temporary = `${filePath}.gdx-history-${crypto.randomUUID()}`;
   await fs.writeFile(temporary, bytes);
   await fs.rename(temporary, filePath).catch(async (error) => {
      await fs.rm(temporary, { force: true });
      throw error;
   });
}

function refOid(state: HistoryRefState): string | null {
   return state.kind === 'oid' ? state.oid : state.kind === 'symbolic' ? state.oid : null;
}

function equalHead(left: HistoryHeadState, right: HistoryHeadState): boolean {
   return JSON.stringify(left) === JSON.stringify(right);
}

function sameBytes(left: Buffer | null, right: Buffer | null): boolean {
   return left === null ? right === null : right !== null && left.equals(right);
}

function checksum(value: Uint8Array | null): string {
   return crypto.createHash('sha256').update(value ?? Buffer.alloc(0)).digest('hex');
}

function tokenFingerprint(value: unknown) {
   return { algorithm: 'sha256' as const, value: checksum(Buffer.from(JSON.stringify(value))) };
}

function text(value: Uint8Array): string {
   return Buffer.from(value).toString('utf8').trim();
}

function message(error: unknown): string {
   return error instanceof Error ? error.message : String(error);
}

function resultExitCode(value: unknown): number {
   return typeof value === 'number' && Number.isInteger(value) ? value : 0;
}

function errorExitCode(error: unknown): number {
   return typeof error === 'object' && error !== null && 'exitCode' in error && Number.isInteger(error.exitCode)
      ? Number(error.exitCode)
      : 1;
}

function normalizeCount(count = 1): number {
   if (!Number.isSafeInteger(count) || count < 1) throw new RangeError('History count must be a positive integer.');
   return count;
}
