import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { execa } from 'execa';

import { GdxContext, GdxRepositoryLocation } from '@/common/types';
import { ReversibleCapturePlan } from '@/modules/history/classifier';
import {
   createHistoryTransactionId,
   createHistoryStoragePaths,
   readHistoryTimeline,
   readHistoryTransactionManifest,
   recordHistoryTransaction,
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
   HistorySource,
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
   const after = await captureBoundary(capture.ctx, capture.gitDir, capture.plan);
   const refs = changedRefs(capture.before.refs, after.refs);
   const recipe = await buildRecipe(capture, after, refs);
   if (!recipe) return null;

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

   try {
      return (
         await recordHistoryTransaction(capture.ctx.git$, input, {
            maxEntries: options.maxEntries,
            repository: capture.repository,
         })
      ).manifest;
   } catch (error) {
      await fs.rm(path.join(capture.historyDir, 'artifacts', capture.id), {
         recursive: true,
         force: true,
      });
      throw error;
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
      return await operation();
   }

   try {
      const value = await operation();
      await finalizeHistoryTransaction(capture, {
         exitCode: resultExitCode(value),
         maxEntries: options.maxEntries,
      }).catch((error) => Logger.warn(`History finalization skipped: ${message(error)}`, 'history'));
      return value;
   } catch (error) {
      await finalizeHistoryTransaction(capture, {
         exitCode: errorExitCode(error),
         maxEntries: options.maxEntries,
      }).catch(() => undefined);
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

/** Captures HEAD, named refs, or raw index bytes according to the selected recipe. */
async function captureBoundary(
   ctx: GdxContext,
   gitDir: string,
   plan: ReversibleCapturePlan
): Promise<Boundary> {
   const headPromise = plan.kind === 'head-soft' || plan.kind === 'switch'
      ? captureHead(ctx)
      : Promise.resolve(undefined);
   const refsPromise = plan.kind === 'refs'
      ? captureRefs(ctx, plan.refs)
      : Promise.resolve(new Map<string, HistoryRefState>());
   const indexPromise = plan.kind === 'raw-index'
      ? readOptional(path.join(gitDir, 'index'))
      : Promise.resolve(undefined);
   const [head, refs, index] = await Promise.all([headPromise, refsPromise, indexPromise]);
   return { head, refs, index };
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
      const result = await runGit(ctx, ['show-ref', '--verify', '--hash', name], true);
      const state: HistoryRefState = result.exitCode === 0
         ? { kind: 'oid', oid: text(result.stdout) }
         : { kind: 'missing' };
      return [name, state] as const;
   }));
   return new Map(values);
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
   return [...before].flatMap(([name, oldValue]) => {
      const newValue = after.get(name) ?? { kind: 'missing' as const };
      return JSON.stringify(oldValue) === JSON.stringify(newValue) ? [] : [{ name, before: oldValue, after: newValue }];
   });
}

/** Executes Git with the history recursion guard and binary-safe output. */
async function runGit(
   ctx: GdxContext,
   args: readonly string[],
   allowFailure = false,
   input?: Uint8Array | string,
   reflogAction?: string
): Promise<GitResult> {
   const command = Array.isArray(ctx.git$) ? ctx.git$ : [ctx.git$];
   const result = await execa(command[0], [...command.slice(1), ...args], {
      env: reflogAction
         ? { ...HISTORY_GIT_CHILD_ENV, GIT_REFLOG_ACTION: reflogAction }
         : HISTORY_GIT_CHILD_ENV,
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
