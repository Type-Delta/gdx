import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { execa } from 'execa';

import { GdxContext } from '@/common/types';
import Logger from '@/utils/logger';
import { ReversibleCapturePlan } from '@/modules/history/classifier';
import {
   createHistoryTransactionId,
   readHistoryTimeline,
   readHistoryTransactionManifest,
   recordHistoryTransaction,
   resolveHistoryStoragePaths,
   setHistoryCursor,
} from '@/modules/history/storage';
import {
   HistoryArtifactReference,
   HistoryCommandMetadata,
   HistoryControlChange,
   HistoryControlKind,
   HistoryControlState,
   HistoryFingerprint,
   HistoryFingerprints,
   HistoryHeadChange,
   HistoryHeadState,
   HistoryIndexChange,
   HistoryIndexRecipe,
   HistoryIndexState,
   HistoryPathChange,
   HistoryPathChangeKind,
   HistoryPathState,
   HistoryRawPath,
   HistoryRefChange,
   HistoryRefState,
   HistoryRepositoryFingerprint,
   HistorySource,
   HistoryTransactionInput,
   HistoryTransactionManifest,
} from '@/modules/history/types';

/** Guard inherited by every Git child started by the history engine. */
export const HISTORY_GIT_CHILD_ENV = { GDX_HISTORY_GUARD: '1' } as const;

const EMPTY_FINGERPRINT = fingerprint('');
const CONTROL_ROOTS = [
   'MERGE_HEAD',
   'MERGE_MSG',
   'MERGE_MODE',
   'AUTO_MERGE',
   'CHERRY_PICK_HEAD',
   'REVERT_HEAD',
   'REBASE_HEAD',
   'ORIG_HEAD',
   'BISECT_LOG',
   'BISECT_START',
   'BISECT_NAMES',
   'sequencer',
   'rebase-apply',
   'rebase-merge',
] as const;

interface GitResult {
   stdout: Buffer;
   stderr: Buffer;
   exitCode: number;
}

interface IndexEntry {
   mode: string;
   oid: string;
   stage: number;
   path: HistoryRawPath;
}

interface CandidateIndex {
   state: HistoryIndexState;
   raw: Buffer;
   shared: Array<{ oid: string; raw: Buffer }>;
   canUseTree: boolean;
   entries: Map<string, IndexEntry[]>;
}

interface CapturedPath {
   path: HistoryRawPath;
   state: HistoryPathState;
}

interface ControlFile {
   path: string;
   bytesBase64: string;
   mode: number;
}

interface CapturedControl {
   state: HistoryControlState;
   files: ControlFile[];
}

interface BoundarySnapshot {
   head: HistoryHeadState;
   refs: Map<string, HistoryRefState>;
   index: CandidateIndex;
   dirtyPaths: Map<string, CapturedPath>;
   control: CapturedControl;
}

const DEFAULT_CAPTURE_PLAN: ReversibleCapturePlan = {
   domains: ['refs', 'index', 'worktree', 'untracked', 'stash'],
   pathspecs: [],
   overwriteFlags: [],
   overwrites: true,
   needsControlState: true,
};

/** In-memory pre-command candidate. Raw index bytes are not made durable until finalization. */
export interface HistoryTransactionCapture {
   ctx: GdxContext;
   id: string;
   root: string;
   gitDir: string;
   historyDir: string;
   source: HistorySource;
   action: string;
   argv: string[];
   startedAt: string;
   plan: ReversibleCapturePlan;
   before: BoundarySnapshot;
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

/** A detected stale surface that prevents a safe undo or redo. */
export interface HistoryDivergence {
   transaction: HistoryTransactionManifest;
   direction: HistoryApplyDirection;
   surfaces: Array<keyof HistoryRepositoryFingerprint>;
   expected: HistoryRepositoryFingerprint;
   actual: HistoryRepositoryFingerprint;
}

/** Direction in which a recorded transaction is being applied. */
export type HistoryApplyDirection = 'undo' | 'redo';

/** Options controlling stale-state override behavior. */
export interface ApplyHistoryTransactionOptions {
   force?: boolean | ((divergence: HistoryDivergence) => boolean | Promise<boolean>);
   snapshot?: (divergence: HistoryDivergence) => void | Promise<void>;
}

/** Options for multi-step timeline undo and redo. */
export interface MoveHistoryOptions extends ApplyHistoryTransactionOptions {
   count?: number;
}

/** Raised when repository state no longer matches a transaction boundary. */
export class HistoryDivergenceError extends Error {
   readonly divergence: HistoryDivergence;

   constructor(divergence: HistoryDivergence) {
      super(`History ${divergence.direction} refused: repository ${divergence.surfaces.join(', ')} diverged.`);
      this.name = 'HistoryDivergenceError';
      this.divergence = divergence;
   }
}

/**
 * Captures the exact pre-command repository surfaces needed by routed history.
 * @param ctx - GDX context whose Git command identifies the worktree.
 * @param options - Redacted command metadata.
 * @returns An in-memory candidate to finalize after the routed operation.
 */
export async function beginHistoryTransaction(
   ctx: GdxContext,
   options: BeginHistoryTransactionOptions
): Promise<HistoryTransactionCapture> {
   const locations = await resolveHistoryStoragePaths(ctx.git$);
   const plan = options.capture ?? DEFAULT_CAPTURE_PLAN;
   const before = await captureBoundary(ctx, locations.root, locations.gitDir, plan, options.action, options.argv);
   return {
      ctx,
      id: createHistoryTransactionId(),
      root: locations.root,
      gitDir: locations.gitDir,
      historyDir: locations.historyDir,
      source: options.source ?? 'gdx',
      action: options.action,
      argv: [...options.argv],
      startedAt: options.startedAt ?? new Date().toISOString(),
      plan,
      before,
   };
}

/** Alias emphasizing capture/finalize routing semantics. */
export const captureHistoryTransaction = beginHistoryTransaction;

/**
 * Finalizes a candidate, persisting only changed surfaces and required recipes.
 * @param capture - Candidate returned by beginHistoryTransaction.
 * @param options - Command result and retention behavior.
 * @returns Recorded manifest, an unrecorded input, or null when nothing changed.
 */
export async function finalizeHistoryTransaction(
   capture: HistoryTransactionCapture,
   options: FinalizeHistoryTransactionOptions = {}
): Promise<HistoryTransactionManifest | HistoryTransactionInput | null> {
   const after = await captureBoundary(
      capture.ctx,
      capture.root,
      capture.gitDir,
      capture.plan,
      capture.action,
      capture.argv
   );
   const refs = changedRefs(capture.before.refs, after.refs);
   const head = equal(capture.before.head, after.head)
      ? undefined
      : ({ before: capture.before.head, after: after.head } satisfies HistoryHeadChange);
   const hasIndexChange = capture.before.index.state.fingerprint.value !== after.index.state.fingerprint.value;
   const capturesPaths =
      capture.plan.domains.includes('worktree') || capture.plan.domains.includes('untracked');
   const pathKeys = capturesPaths ? changedPathKeys(capture.before, after) : [];
   const paths = await buildPathChanges(capture.before, after, pathKeys);
   const hasControlChange =
      capture.before.control.state.fingerprint.value !== after.control.state.fingerprint.value;

   if (!refs.length && !head && !hasIndexChange && !paths.length && !hasControlChange) return null;

   const index = hasIndexChange
      ? await buildIndexChange(capture, capture.before.index, after.index)
      : undefined;
   const control = hasControlChange
      ? await buildControlChange(capture, capture.before.control, after.control)
      : undefined;
   const fingerprints = buildTransactionFingerprints(
      refs,
      head,
      index,
      paths,
      control
   );
   const command: HistoryCommandMetadata = {
      command: capture.action,
      argv: capture.argv,
      cwd: capture.root,
      startedAt: capture.startedAt,
      finishedAt: options.finishedAt ?? new Date().toISOString(),
      exitCode: options.exitCode ?? 0,
   };
   const capability = paths.some((change) => change.before.kind === 'gitlink' || change.after.kind === 'gitlink')
      ? 'conditional'
      : 'exact';
   const input: HistoryTransactionInput = {
      id: capture.id,
      source: capture.source,
      command,
      capability,
      refs,
      head,
      index,
      paths: paths.length ? paths : undefined,
      control,
      fingerprints,
   };

   if (options.record === false) return input;
   let manifest: HistoryTransactionManifest;
   let retained: boolean;
   try {
      const result = await recordHistoryTransaction(capture.ctx.git$, input, {
         maxEntries: options.maxEntries,
      });
      manifest = result.manifest;
      retained = result.timeline.entries.includes(manifest.id);
   } catch (error) {
      await fs.rm(path.join(capture.historyDir, 'artifacts', capture.id), {
         recursive: true,
         force: true,
      });
      throw error;
   }
   if (retained) await createTransactionCapsule(capture.ctx, manifest);
   return manifest;
}

/**
 * Runs an operation inside routed capture. Nested guarded subprocesses are never recorded.
 * @param ctx - GDX command context.
 * @param options - Redacted action metadata and retention behavior.
 * @param operation - Routed operation to execute exactly once.
 * @returns The operation result.
 */
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
      Logger.warn(
         `History pre-capture failed; running without a reversible transaction: ${error instanceof Error ? error.message : String(error)}`,
         'history'
      );
      return await operation();
   }
   try {
      const value = await operation();
      try {
         await finalizeHistoryTransaction(capture, {
            exitCode: resultExitCode(value),
            maxEntries: options.maxEntries,
         });
      } catch (error) {
         Logger.warn(
            `Command succeeded, but its history transaction could not be finalized: ${error instanceof Error ? error.message : String(error)}`,
            'history'
         );
      }
      return value;
   } catch (error) {
      await finalizeHistoryTransaction(capture, {
         exitCode: errorExitCode(error),
         maxEntries: options.maxEntries,
      }).catch((historyError) => {
         Logger.warn(
            `Failed command changed state, but history finalization also failed: ${historyError instanceof Error ? historyError.message : String(historyError)}`,
            'history'
         );
      });
      throw error;
   }
}

/** Alias used by dispatch integration. */
export const runRoutedHistoryTransaction = runHistoryTransaction;

/**
 * Applies one manifest without creating a new transaction.
 * @param ctx - GDX context for the target worktree.
 * @param transaction - Transaction to undo or redo.
 * @param direction - Boundary to restore.
 * @param options - Divergence override callbacks.
 */
export async function applyHistoryTransaction(
   ctx: GdxContext,
   transaction: HistoryTransactionManifest,
   direction: HistoryApplyDirection,
   options: ApplyHistoryTransactionOptions = {}
): Promise<void> {
   const expectedSide = direction === 'undo' ? 'after' : 'before';
   const expected = transaction.fingerprints[expectedSide];
   const actual = await currentTransactionFingerprint(ctx, transaction, expectedSide);
   const surfaces = fingerprintDifferences(expected, actual);
   if (surfaces.length) {
      const divergence = { transaction, direction, surfaces, expected, actual } satisfies HistoryDivergence;
      const allowed =
         typeof options.force === 'function' ? await options.force(divergence) : options.force === true;
      if (!allowed) throw new HistoryDivergenceError(divergence);
      await options.snapshot?.(divergence);
   }

   await applyRefs(ctx, transaction.refs, direction);
   if (transaction.head) await applyHead(ctx, transaction.head, direction);
   if (transaction.index) await applyIndex(ctx, transaction.index, direction);
   if (transaction.paths) await applyPaths(ctx, transaction.paths, direction);
   if (transaction.control) await applyControl(ctx, transaction.control, direction);
}

/**
 * Undoes applied timeline entries, advancing the cursor after each successful restore only.
 * @param ctx - GDX context for the current worktree.
 * @param options - Step count and stale-state behavior.
 * @returns Successfully undone manifests in execution order.
 */
export async function undoHistory(
   ctx: GdxContext,
   options: MoveHistoryOptions = {}
): Promise<HistoryTransactionManifest[]> {
   const count = normalizeCount(options.count);
   const completed: HistoryTransactionManifest[] = [];
   for (let step = 0; step < count; step++) {
      const timeline = await readHistoryTimeline(ctx.git$);
      if (timeline.cursor === 0) break;
      const id = timeline.entries[timeline.cursor - 1];
      const manifest = await readHistoryTransactionManifest(ctx.git$, id);
      if (!manifest) throw new Error(`History manifest is missing: ${id}`);
      await applyHistoryTransaction(ctx, manifest, 'undo', options);
      await setHistoryCursor(ctx.git$, timeline.cursor - 1);
      completed.push(manifest);
   }
   return completed;
}

/**
 * Redoes timeline entries, advancing the cursor after each successful restore only.
 * @param ctx - GDX context for the current worktree.
 * @param options - Step count and stale-state behavior.
 * @returns Successfully redone manifests in execution order.
 */
export async function redoHistory(
   ctx: GdxContext,
   options: MoveHistoryOptions = {}
): Promise<HistoryTransactionManifest[]> {
   const count = normalizeCount(options.count);
   const completed: HistoryTransactionManifest[] = [];
   for (let step = 0; step < count; step++) {
      const timeline = await readHistoryTimeline(ctx.git$);
      if (timeline.cursor >= timeline.entries.length) break;
      const id = timeline.entries[timeline.cursor];
      const manifest = await readHistoryTransactionManifest(ctx.git$, id);
      if (!manifest) throw new Error(`History manifest is missing: ${id}`);
      await applyHistoryTransaction(ctx, manifest, 'redo', options);
      await setHistoryCursor(ctx.git$, timeline.cursor + 1);
      completed.push(manifest);
   }
   return completed;
}

/** Captures repository surfaces in parallel after locations have been resolved. */
async function captureBoundary(
   ctx: GdxContext,
   root: string,
   gitDir: string,
   plan: ReversibleCapturePlan,
   action: string,
   argv: readonly string[]
): Promise<BoundarySnapshot> {
   const needsRefs = plan.domains.includes('refs') || plan.domains.includes('stash');
   const needsIndex = plan.domains.includes('index');
   const needsPaths = plan.domains.includes('worktree') || plan.domains.includes('untracked');

   const refsPromise = needsRefs
      ? captureHeadAndRefs(ctx)
      : Promise.resolve({ head: emptyHeadState(), refs: new Map<string, HistoryRefState>() });
   const indexPromise = needsIndex
      ? captureIndex(ctx)
      : needsPaths
        ? captureIndexEntriesOnly(ctx, plan)
        : Promise.resolve(emptyCandidateIndex());
   const namesPromise = needsPaths
      ? captureDirtyPathNames(ctx, plan, action, argv)
      : Promise.resolve(new Map<string, Buffer>());
   const controlPromise = plan.needsControlState
      ? captureControl(gitDir)
      : Promise.resolve(emptyControlState());

   const [{ head, refs }, index, dirtyResult, control] = await Promise.all([
      refsPromise,
      indexPromise,
      namesPromise,
      controlPromise,
   ]);
   const dirtyPaths = needsPaths
      ? await captureDirtyPaths(ctx, root, dirtyResult, index.entries)
      : new Map<string, CapturedPath>();
   return { head, refs, index, dirtyPaths, control };
}

/** Captures HEAD and refs for actions whose classifier includes the refs domain. */
async function captureHeadAndRefs(
   ctx: GdxContext
): Promise<{ head: HistoryHeadState; refs: Map<string, HistoryRefState> }> {
   const [symbolicHead, headOid, refsResult] = await Promise.all([
      runGit(ctx, ['symbolic-ref', '-q', 'HEAD'], { allowFailure: true }),
      runGit(ctx, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true }),
      runGit(ctx, ['for-each-ref', '--format=%(refname)%09%(objectname)%09%(symref)']),
   ]);
   const headSymbolic = text(symbolicHead.stdout);
   const headDirectOid = text(headOid.stdout);
   const head: HistoryHeadState = headSymbolic
      ? {
           value: { kind: 'symbolic', target: headSymbolic, oid: headDirectOid || null },
           unborn: !headDirectOid,
        }
      : headDirectOid
        ? { value: { kind: 'oid', oid: headDirectOid }, unborn: false }
        : emptyHeadState();
   return { head, refs: parseRefs(text(refsResult.stdout)) };
}

/** Captures the exact candidate index only for plans that include the index domain. */
async function captureIndex(ctx: GdxContext): Promise<CandidateIndex> {
   const [treeResult, stageResult, tagResult, indexPathResult, sharedPathResult] =
      await Promise.all([
         runGit(ctx, ['write-tree'], { allowFailure: true }),
         runGit(ctx, ['ls-files', '--stage', '-z']),
         runGit(ctx, ['ls-files', '-v', '-z']),
         runGit(ctx, ['rev-parse', '--path-format=absolute', '--git-path', 'index']),
         runGit(ctx, ['rev-parse', '--path-format=absolute', '--shared-index-path'], {
            allowFailure: true,
         }),
      ]);
   const entries = parseIndexEntries(stageResult.stdout);
   const indexPath = text(indexPathResult.stdout);
   const raw = await readOptionalFile(indexPath);
   const sharedPath = text(sharedPathResult.stdout);
   const shared = sharedPath
      ? [
           {
              oid: path.basename(sharedPath).replace(/^sharedindex\./, ''),
              raw: await readOptionalFile(sharedPath),
           },
        ]
      : [];
   const treeOid = treeResult.exitCode === 0 ? text(treeResult.stdout) || null : null;
   const tags = splitNull(tagResult.stdout);
   return {
      state: {
         treeOid,
         entryCount: [...entries.values()].reduce((count, values) => count + values.length, 0),
         fingerprint: fingerprint(
            Buffer.concat([stageResult.stdout, Buffer.from([0]), tagResult.stdout])
         ),
      },
      raw,
      shared,
      canUseTree:
         treeOid !== null && shared.length === 0 && tags.every((entry) => entry[0] === 0x48),
      entries,
   };
}

/** Captures only tracked path identities needed to derive worktree recipes. */
async function captureIndexEntriesOnly(
   ctx: GdxContext,
   plan: ReversibleCapturePlan
): Promise<CandidateIndex> {
   const result = await runGit(ctx, ['ls-files', '--stage', '-z']);
   const entries = filterIndexEntries(parseIndexEntries(result.stdout), plan.pathspecs);
   const empty = emptyCandidateIndex();
   return {
      ...empty,
      entries,
      state: {
         ...empty.state,
         entryCount: [...entries.values()].reduce((count, values) => count + values.length, 0),
      },
   };
}

/** Runs one Git child with an explicit recursion guard and lossless binary output. */
async function runGit(
   ctx: GdxContext,
   args: readonly string[],
   options: { allowFailure?: boolean; input?: Uint8Array | string } = {}
): Promise<GitResult> {
   const command = Array.isArray(ctx.git$) ? ctx.git$ : [ctx.git$];
   const executable = command[0];
   const result = await execa(executable, [...command.slice(1), ...args], {
      env: HISTORY_GIT_CHILD_ENV,
      encoding: 'base64',
      input: options.input,
      reject: false,
      stripFinalNewline: false,
   });
   const gitResult = {
      stdout: Buffer.from(result.stdout || '', 'base64'),
      stderr: Buffer.from(result.stderr || '', 'base64'),
      exitCode: result.exitCode ?? 1,
   };
   if (!options.allowFailure && gitResult.exitCode !== 0) {
      throw new Error(`git ${args[0] || ''} failed: ${text(gitResult.stderr) || `exit ${gitResult.exitCode}`}`);
   }
   return gitResult;
}

/** Parses ref names, OIDs, and symbolic targets from for-each-ref output. */
function parseRefs(output: string): Map<string, HistoryRefState> {
   const refs = new Map<string, HistoryRefState>();
   for (const line of output.split(/\r?\n/)) {
      if (!line) continue;
      const [name, oid, symbolicTarget] = line.split('\t');
      refs.set(
         name,
         symbolicTarget
            ? { kind: 'symbolic', target: symbolicTarget, oid: oid || null }
            : { kind: 'oid', oid }
      );
   }
   return refs;
}

/** Parses null-delimited stage records without decoding path bytes. */
function parseIndexEntries(output: Buffer): Map<string, IndexEntry[]> {
   const entries = new Map<string, IndexEntry[]>();
   for (const record of splitNull(output)) {
      const tab = record.indexOf(0x09);
      if (tab < 0) continue;
      const metadata = record.subarray(0, tab).toString('ascii').split(' ');
      if (metadata.length !== 3) continue;
      const rawPath = record.subarray(tab + 1);
      const pathInfo = rawPathInfo(rawPath, true);
      const entry = {
         mode: metadata[0],
         oid: metadata[1],
         stage: Number(metadata[2]),
         path: pathInfo,
      } satisfies IndexEntry;
      const key = pathInfo.bytesBase64;
      entries.set(key, [...(entries.get(key) || []), entry]);
   }
   return entries;
}

/** Collects dirty tracked and untracked path bytes with rename detection disabled. */
async function captureDirtyPathNames(
   ctx: GdxContext,
   plan: ReversibleCapturePlan,
   action: string,
   argv: readonly string[]
): Promise<Map<string, Buffer>> {
   const commands: string[][] = [];
   if (plan.domains.includes('worktree')) {
      commands.push(['diff', '--name-only', '--no-renames', '-z']);
   }
   if (plan.domains.includes('untracked')) {
      const onlyIgnored = argv.some((argument) => argument === '-X' || /^-[^-]*X/.test(argument));
      const includeIgnored = argv.some(
         (argument) => argument === '-x' || /^-[^-]*x/.test(argument)
      );
      const untracked = ['ls-files', '--others'];
      if (onlyIgnored) untracked.push('--ignored', '--exclude-standard');
      else if (!includeIgnored) untracked.push('--exclude-standard');
      untracked.push('-z');
      commands.push(untracked);
   }
   if (action === 'clear') {
      commands.push(['diff', '--cached', '--name-only', '--no-renames', '-z']);
   }
   const results = await Promise.all(commands.map((args) => runGit(ctx, args)));
   const paths = new Map<string, Buffer>();
   for (const result of results) {
      for (const rawPath of splitNull(result.stdout)) {
         if (!matchesAnyPathspec(rawPath.toString('utf8'), plan.pathspecs)) continue;
         paths.set(rawPath.toString('base64'), rawPath);
      }
   }
   return paths;
}

/** Hashes only dirty path preimages into Git's object database. */
async function captureDirtyPaths(
   ctx: GdxContext,
   root: string,
   names: Map<string, Buffer>,
   entries: Map<string, IndexEntry[]>
): Promise<Map<string, CapturedPath>> {
   const captured = await Promise.all(
      [...names.entries()].map(async ([key, rawPath]) => {
         const tracked = entries.has(key);
         const pathInfo = rawPathInfo(rawPath, tracked);
         const state = await captureFileState(ctx, root, pathInfo);
         return [key, { path: pathInfo, state }] as const;
      })
   );
   return new Map(captured);
}

/** Captures one worktree entry and stores file/symlink bytes as a Git blob. */
async function captureFileState(
   ctx: GdxContext,
   root: string,
   filePath: HistoryRawPath
): Promise<HistoryPathState> {
   const absolute = safeRepoPath(root, filePath);
   const stat = await fs.lstat(absolute).catch((error: unknown) => {
      if (fileSystemError(error, 'ENOENT')) return null;
      throw error;
   });
   if (!stat) return absentPathState();
   if (stat.isDirectory()) {
      return { kind: 'directory', mode: '040000', size: null, oid: null, fingerprint: null };
   }

   const isSymlink = stat.isSymbolicLink();
   const bytes = isSymlink
      ? Buffer.from(await fs.readlink(absolute), 'utf8')
      : await fs.readFile(absolute);
   const oid = text((await runGit(ctx, ['hash-object', '-w', '--stdin'], { input: bytes })).stdout);
   const mode = isSymlink ? '120000' : stat.mode & 0o111 ? '100755' : '100644';
   return {
      kind: isSymlink ? 'symlink' : 'file',
      mode,
      size: bytes.byteLength,
      oid,
      fingerprint: { algorithm: 'git-oid', value: oid },
   };
}

/** Captures relevant sequencer, merge, bisect, and ORIG_HEAD control files. */
async function captureControl(gitDir: string): Promise<CapturedControl> {
   const files: ControlFile[] = [];
   for (const rootName of CONTROL_ROOTS) {
      await collectControlFiles(gitDir, rootName, files);
   }
   files.sort((left, right) => left.path.localeCompare(right.path));
   const state: HistoryControlState = {
      kind: controlKind(files),
      inProgress: files.some((file) => file.path !== 'ORIG_HEAD'),
      headName: readControlText(files, 'head-name'),
      originalHead:
         readControlText(files, 'orig-head') || readControlText(files, 'ORIG_HEAD'),
      step: readControlNumber(files, 'msgnum'),
      totalSteps: readControlNumber(files, 'end'),
      fingerprint: fingerprint(stableStringify(files)),
   };
   return { state, files };
}

/** Recursively collects a permitted control root. */
async function collectControlFiles(
   gitDir: string,
   relativePath: string,
   output: ControlFile[]
): Promise<void> {
   const absolute = path.join(gitDir, ...relativePath.split('/'));
   const stat = await fs.lstat(absolute).catch((error: unknown) => {
      if (fileSystemError(error, 'ENOENT')) return null;
      throw error;
   });
   if (!stat) return;
   if (stat.isDirectory()) {
      const names = await fs.readdir(absolute);
      await Promise.all(
         names.map((name) =>
            collectControlFiles(gitDir, `${relativePath}/${name}`, output)
         )
      );
      return;
   }
   output.push({
      path: relativePath.replaceAll('\\', '/'),
      bytesBase64: (await fs.readFile(absolute)).toString('base64'),
      mode: stat.mode,
   });
}

/** Infers active Git control operation from captured paths. */
function controlKind(files: ControlFile[]): HistoryControlKind {
   const names = files.map((file) => file.path);
   if (names.some((name) => name.startsWith('rebase-'))) return 'rebase';
   if (names.includes('MERGE_HEAD')) return 'merge';
   if (names.includes('CHERRY_PICK_HEAD')) return 'cherry-pick';
   if (names.includes('REVERT_HEAD')) return 'revert';
   if (names.some((name) => name.startsWith('BISECT_'))) return 'bisect';
   if (names.some((name) => name.startsWith('rebase-apply/'))) return 'am';
   return 'none';
}

/** Returns only refs whose complete direct/symbolic values changed. */
function changedRefs(
   before: Map<string, HistoryRefState>,
   after: Map<string, HistoryRefState>
): HistoryRefChange[] {
   const names = new Set([...before.keys(), ...after.keys()]);
   return [...names]
      .sort()
      .flatMap((name) => {
         const previous = before.get(name) || ({ kind: 'missing' } as const);
         const next = after.get(name) || ({ kind: 'missing' } as const);
         return equal(previous, next) ? [] : [{ name, before: previous, after: next }];
      });
}

/** Finds path identities whose index entry or dirty preimage changed. */
function changedPathKeys(before: BoundarySnapshot, after: BoundarySnapshot): string[] {
   const keys = new Set([
      ...before.index.entries.keys(),
      ...after.index.entries.keys(),
      ...before.dirtyPaths.keys(),
      ...after.dirtyPaths.keys(),
   ]);
   return [...keys]
      .filter((key) => {
         const beforeEntries = before.index.entries.get(key) || [];
         const afterEntries = after.index.entries.get(key) || [];
         const beforeDirty = before.dirtyPaths.get(key)?.state;
         const afterDirty = after.dirtyPaths.get(key)?.state;
         return !equal(beforeEntries, afterEntries) || !equal(beforeDirty, afterDirty);
      })
      .sort();
}

/** Builds exact path deltas, deriving clean states from stage-zero index blobs. */
async function buildPathChanges(
   before: BoundarySnapshot,
   after: BoundarySnapshot,
   keys: string[]
): Promise<HistoryPathChange[]> {
   return keys.map((key) => {
      const beforeCaptured = boundaryPath(before, key);
      const afterCaptured = boundaryPath(after, key);
      const beforeEntries = before.index.entries.get(key) || [];
      const afterEntries = after.index.entries.get(key) || [];
      const staged = !equal(beforeEntries, afterEntries);
      return {
         path: {
            ...afterCaptured.path,
            tracked: afterCaptured.path.tracked || beforeCaptured.path.tracked,
         },
         kind: pathChangeKind(beforeCaptured.state, afterCaptured.state, beforeEntries, afterEntries),
         before: beforeCaptured.state,
         after: afterCaptured.state,
         staged,
      } satisfies HistoryPathChange;
   });
}

/** Resolves one boundary's exact worktree state from a dirty preimage or index entry. */
function boundaryPath(snapshot: BoundarySnapshot, key: string): CapturedPath {
   const dirty = snapshot.dirtyPaths.get(key);
   if (dirty) return dirty;
   const entries = snapshot.index.entries.get(key) || [];
   const stageZero = entries.find((entry) => entry.stage === 0);
   const pathInfo = stageZero?.path || entries[0]?.path || rawPathInfo(Buffer.from(key, 'base64'), entries.length > 0);
   if (!stageZero) return { path: pathInfo, state: absentPathState() };
   const kind = stageZero.mode === '160000' ? 'gitlink' : stageZero.mode === '120000' ? 'symlink' : 'file';
   return {
      path: { ...pathInfo, tracked: true },
      state: {
         kind,
         mode: stageZero.mode,
         size: null,
         oid: stageZero.oid,
         fingerprint: { algorithm: 'git-oid', value: stageZero.oid },
      },
   };
}

/** Classifies a path transition for display and safety diagnostics. */
function pathChangeKind(
   before: HistoryPathState,
   after: HistoryPathState,
   beforeEntries: IndexEntry[],
   afterEntries: IndexEntry[]
): HistoryPathChangeKind {
   if (beforeEntries.some((entry) => entry.stage > 0) || afterEntries.some((entry) => entry.stage > 0)) {
      return 'unmerged';
   }
   if (before.kind === 'absent') return 'add';
   if (after.kind === 'absent') return 'delete';
   if (before.kind !== after.kind || before.mode !== after.mode) return 'type-change';
   return 'modify';
}

/** Creates tree/raw/shared restoration recipes only after an index change is known. */
async function buildIndexChange(
   capture: HistoryTransactionCapture,
   before: CandidateIndex,
   after: CandidateIndex
): Promise<HistoryIndexChange> {
   return {
      before: before.state,
      after: after.state,
      undo: await persistIndexRecipe(capture, 'index-before', before),
      redo: await persistIndexRecipe(capture, 'index-after', after),
   };
}

/** Prefers a reproducible tree and otherwise persists exact candidate bytes. */
async function persistIndexRecipe(
   capture: HistoryTransactionCapture,
   label: string,
   index: CandidateIndex
): Promise<HistoryIndexRecipe> {
   if (index.canUseTree && index.state.treeOid) {
      return { kind: 'tree', treeOid: index.state.treeOid };
   }
   if (index.shared.length) {
      const blobs = await Promise.all([
         persistArtifact(capture, `${label}-index`, index.raw).then((blob) => ({ oid: 'index', blob })),
         ...index.shared.map(async (shared) => ({
            oid: shared.oid,
            blob: await persistArtifact(capture, `${label}-shared-${shared.oid}`, shared.raw),
         })),
      ]);
      return { kind: 'shared-blobs', blobs, checksum: sha256(index.raw) };
   }
   return {
      kind: 'raw',
      blob: await persistArtifact(capture, label, index.raw),
      checksum: sha256(index.raw),
   };
}

/** Persists changed control boundaries as one deterministic artifact. */
async function buildControlChange(
   capture: HistoryTransactionCapture,
   before: CapturedControl,
   after: CapturedControl
): Promise<HistoryControlChange> {
   const bytes = Buffer.from(stableStringify({ before: before.files, after: after.files }));
   return {
      before: before.state,
      after: after.state,
      artifacts: [await persistArtifact(capture, 'control', bytes)],
   };
}

/** Writes a content-addressed artifact atomically under repository-local history storage. */
async function persistArtifact(
   capture: HistoryTransactionCapture,
   label: string,
   bytes: Buffer
): Promise<HistoryArtifactReference> {
   const digest = sha256(bytes);
   const relative = path.posix.join('artifacts', capture.id, `${label}-${digest}.bin`);
   const target = path.join(capture.historyDir, ...relative.split('/'));
   await fs.mkdir(path.dirname(target), { recursive: true });
   const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
   try {
      await fs.writeFile(temporary, bytes, { flag: 'wx' });
      await fs.rename(temporary, target).catch(async (error: unknown) => {
         if (!fileSystemError(error, 'EEXIST')) throw error;
         await fs.unlink(temporary);
      });
   } finally {
      await fs.unlink(temporary).catch(() => undefined);
   }
   return { path: relative, size: bytes.byteLength, fingerprint: fingerprint(bytes) };
}

/** Builds protected fingerprints from only the surfaces stored by this transaction. */
function buildTransactionFingerprints(
   refs: HistoryRefChange[],
   head: HistoryHeadChange | undefined,
   index: HistoryIndexChange | undefined,
   paths: HistoryPathChange[],
   control: HistoryControlChange | undefined
): HistoryFingerprints {
   const make = (side: 'before' | 'after') => {
      const refsFingerprint = fingerprint(
         stableStringify(refs.map((change) => [change.name, change[side]]))
      );
      const headFingerprint = head ? fingerprint(stableStringify(head[side])) : EMPTY_FINGERPRINT;
      const indexFingerprint = index ? index[side].fingerprint : EMPTY_FINGERPRINT;
      const pathsFingerprint = fingerprint(
         stableStringify(
            paths.map((change) => [change.path.bytesBase64, change[side], change.path.tracked])
         )
      );
      const controlFingerprint = control ? control[side].fingerprint : EMPTY_FINGERPRINT;
      return combineRepositoryFingerprint({
         refs: refs.length ? refsFingerprint : EMPTY_FINGERPRINT,
         head: headFingerprint,
         index: indexFingerprint,
         paths: paths.length ? pathsFingerprint : EMPTY_FINGERPRINT,
         control: controlFingerprint,
      });
   };
   return { before: make('before'), after: make('after') };
}

/** Adds the combined digest to individual protected surface fingerprints. */
function combineRepositoryFingerprint(
   parts: Omit<HistoryRepositoryFingerprint, 'combined'>
): HistoryRepositoryFingerprint {
   return {
      ...parts,
      combined: fingerprint(
         stableStringify([
            parts.refs.value,
            parts.head.value,
            parts.index.value,
            parts.paths.value,
            parts.control.value,
         ])
      ),
   };
}

/** Recomputes the manifest's protected surfaces against current repository state. */
async function currentTransactionFingerprint(
   ctx: GdxContext,
   transaction: HistoryTransactionManifest,
   expectedSide: 'before' | 'after'
): Promise<HistoryRepositoryFingerprint> {
   const locations = await resolveHistoryStoragePaths(ctx.git$);
   const domains: ReversibleCapturePlan['domains'] = [];
   if (transaction.refs.length || transaction.head) domains.push('refs');
   if (transaction.index) domains.push('index');
   if (transaction.paths?.length) domains.push('worktree');
   const snapshot = await captureBoundary(
      ctx,
      locations.root,
      locations.gitDir,
      {
         domains,
         pathspecs: transaction.paths?.map((change) => change.path.display) ?? [],
         overwriteFlags: [],
         overwrites: false,
         needsControlState: !!transaction.control,
      },
      transaction.command?.command ?? 'history-restore',
      transaction.command?.argv ?? []
   );
   const refs = transaction.refs.length
      ? fingerprint(
           stableStringify(
              transaction.refs.map((change) => [
                 change.name,
                 snapshot.refs.get(change.name) || ({ kind: 'missing' } as const),
              ])
           )
        )
      : EMPTY_FINGERPRINT;
   const head = transaction.head
      ? fingerprint(stableStringify(snapshot.head))
      : EMPTY_FINGERPRINT;
   const index = transaction.index ? snapshot.index.state.fingerprint : EMPTY_FINGERPRINT;
   const paths = transaction.paths?.length
      ? fingerprint(
           stableStringify(
              transaction.paths.map((change) => {
                 const current = boundaryPath(snapshot, change.path.bytesBase64);
                 return [change.path.bytesBase64, current.state, change.path.tracked];
              })
           )
        )
      : EMPTY_FINGERPRINT;
   const control = transaction.control ? snapshot.control.state.fingerprint : EMPTY_FINGERPRINT;
   const actual = combineRepositoryFingerprint({ refs, head, index, paths, control });

   // Keep this assertion local: it catches malformed manifests before any mutation.
   const expected = transaction.fingerprints[expectedSide];
   if (!expected?.combined) throw new Error('History transaction is missing boundary fingerprints.');
   return actual;
}

/** Lists stale protected surfaces, excluding the derived combined field. */
function fingerprintDifferences(
   expected: HistoryRepositoryFingerprint,
   actual: HistoryRepositoryFingerprint
): Array<keyof HistoryRepositoryFingerprint> {
   const surfaces: Array<keyof HistoryRepositoryFingerprint> = [
      'refs',
      'head',
      'index',
      'paths',
      'control',
   ];
   return surfaces.filter((surface) => expected[surface].value !== actual[surface].value);
}

/** Applies direct ref changes in one update-ref transaction with expected old values. */
async function applyRefs(
   ctx: GdxContext,
   changes: HistoryRefChange[],
   direction: HistoryApplyDirection
): Promise<void> {
   const sourceSide = direction === 'undo' ? 'after' : 'before';
   const targetSide = direction === 'undo' ? 'before' : 'after';
   const direct = changes.filter(
      (change) => change[sourceSide].kind !== 'symbolic' && change[targetSide].kind !== 'symbolic'
   );
   if (direct.length) {
      const commands = ['start'];
      for (const change of direct) {
         const source = change[sourceSide];
         const target = change[targetSide];
         if (source.kind === 'missing' && target.kind === 'oid') {
            commands.push(`create ${change.name} ${target.oid}`);
         } else if (source.kind === 'oid' && target.kind === 'missing') {
            commands.push(`delete ${change.name} ${source.oid}`);
         } else if (source.kind === 'oid' && target.kind === 'oid') {
            commands.push(`update ${change.name} ${target.oid} ${source.oid}`);
         }
      }
      commands.push('prepare', 'commit', '');
      await runGit(ctx, ['update-ref', '--stdin'], { input: commands.join('\n') });
   }

   for (const change of changes) {
      const source = change[sourceSide];
      const target = change[targetSide];
      if (source.kind !== 'symbolic' && target.kind !== 'symbolic') continue;
      if (target.kind === 'symbolic') {
         await runGit(ctx, ['symbolic-ref', change.name, target.target]);
      } else if (target.kind === 'missing') {
         await runGit(ctx, ['symbolic-ref', '--delete', change.name], { allowFailure: true });
      } else {
         await runGit(ctx, ['update-ref', '--no-deref', change.name, target.oid]);
      }
   }
}

/** Restores symbolic, detached, or unborn HEAD after named refs are updated. */
async function applyHead(
   ctx: GdxContext,
   change: HistoryHeadChange,
   direction: HistoryApplyDirection
): Promise<void> {
   const target = change[direction === 'undo' ? 'before' : 'after'].value;
   const source = change[direction === 'undo' ? 'after' : 'before'].value;
   if (target.kind === 'symbolic') {
      await runGit(ctx, ['symbolic-ref', 'HEAD', target.target]);
   } else if (target.kind === 'oid') {
      const args = ['update-ref', '--no-deref', 'HEAD', target.oid];
      if (source.kind === 'oid') args.push(source.oid);
      await runGit(ctx, args);
   } else {
      throw new Error('Cannot restore a missing HEAD without a symbolic target.');
   }
}

/** Restores the index from its tree, raw, or shared-blob recipe. */
async function applyIndex(
   ctx: GdxContext,
   change: HistoryIndexChange,
   direction: HistoryApplyDirection
): Promise<void> {
   const recipe = direction === 'undo' ? change.undo : change.redo;
   if (!recipe) throw new Error('This transaction has no redo index recipe.');
   if (recipe.kind === 'tree') {
      await runGit(ctx, ['read-tree', recipe.treeOid]);
      return;
   }

   const indexPath = text(
      (await runGit(ctx, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).stdout
   );
   if (recipe.kind === 'raw') {
      const bytes = await readArtifact(ctx, recipe.blob);
      if (sha256(bytes) !== recipe.checksum) throw new Error('History raw index checksum mismatch.');
      await atomicWrite(indexPath, bytes);
      return;
   }

   for (const entry of recipe.blobs) {
      const bytes = await readArtifact(ctx, entry.blob);
      const target = entry.oid === 'index'
         ? indexPath
         : path.join(path.dirname(indexPath), `sharedindex.${entry.oid}`);
      await atomicWrite(target, bytes);
   }
   const primary = recipe.blobs.find((entry) => entry.oid === 'index');
   if (!primary || sha256(await readArtifact(ctx, primary.blob)) !== recipe.checksum) {
      throw new Error('History shared index checksum mismatch.');
   }
}

/** Restores exact changed worktree preimages without touching unrelated paths. */
async function applyPaths(
   ctx: GdxContext,
   changes: HistoryPathChange[],
   direction: HistoryApplyDirection
): Promise<void> {
   const { root } = await resolveHistoryStoragePaths(ctx.git$);
   const side = direction === 'undo' ? 'before' : 'after';
   for (const change of changes) {
      await restorePath(ctx, root, change.path, change[side]);
   }
}

/** Restores one path state from its Git blob or absence marker. */
async function restorePath(
   ctx: GdxContext,
   root: string,
   filePath: HistoryRawPath,
   state: HistoryPathState
): Promise<void> {
   const absolute = safeRepoPath(root, filePath);
   if (state.kind === 'gitlink') return;
   if (state.kind === 'absent') {
      await fs.rm(absolute, { recursive: true, force: true });
      return;
   }
   if (state.kind === 'directory') {
      await fs.mkdir(absolute, { recursive: true });
      return;
   }
   if (!state.oid) throw new Error(`History path ${filePath.display} has no blob OID.`);
   const bytes = (await runGit(ctx, ['cat-file', 'blob', state.oid])).stdout;
   await fs.mkdir(path.dirname(absolute), { recursive: true });
   await fs.rm(absolute, { recursive: true, force: true });
   if (state.kind === 'symlink') {
      await fs.symlink(bytes.toString('utf8'), absolute);
   } else {
      await fs.writeFile(absolute, bytes);
      if (process.platform !== 'win32' && state.mode === '100755') await fs.chmod(absolute, 0o755);
   }
}

/** Restores all relevant control files from the transaction's paired artifact. */
async function applyControl(
   ctx: GdxContext,
   change: HistoryControlChange,
   direction: HistoryApplyDirection
): Promise<void> {
   const locations = await resolveHistoryStoragePaths(ctx.git$);
   const artifact = change.artifacts[0];
   if (!artifact) throw new Error('History control change is missing its restoration artifact.');
   const payload = JSON.parse((await readArtifact(ctx, artifact)).toString('utf8')) as {
      before: ControlFile[];
      after: ControlFile[];
   };
   await Promise.all(
      CONTROL_ROOTS.map((rootName) =>
         fs.rm(path.join(locations.gitDir, rootName), { recursive: true, force: true })
      )
   );
   const files = payload[direction === 'undo' ? 'before' : 'after'];
   for (const file of files) {
      const target = safeControlPath(locations.gitDir, file.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, Buffer.from(file.bytesBase64, 'base64'));
      if (process.platform !== 'win32') await fs.chmod(target, file.mode & 0o777);
   }
}

/** Loads and verifies one repository-local artifact. */
async function readArtifact(
   ctx: GdxContext,
   artifact: HistoryArtifactReference
): Promise<Buffer> {
   const { historyDir } = await resolveHistoryStoragePaths(ctx.git$);
   const target = safeArtifactPath(historyDir, artifact.path);
   const bytes = await fs.readFile(target);
   if (bytes.byteLength !== artifact.size || sha256(bytes) !== artifact.fingerprint.value) {
      throw new Error(`History artifact failed verification: ${artifact.path}`);
   }
   return bytes;
}

/** Anchors rewritten/deleted commits (and annotated tag objects) behind a private ref. */
export async function createTransactionCapsule(
   ctx: GdxContext,
   manifest: HistoryTransactionManifest
): Promise<void> {
   const candidates = new Set<string>();
   for (const change of manifest.refs) {
      for (const state of [change.before, change.after]) {
         if (state.kind === 'oid') candidates.add(state.oid);
         if (state.kind === 'symbolic' && state.oid) candidates.add(state.oid);
      }
   }
   for (const state of manifest.head ? [manifest.head.before.value, manifest.head.after.value] : []) {
      if (state.kind === 'oid') candidates.add(state.oid);
      if (state.kind === 'symbolic' && state.oid) candidates.add(state.oid);
   }
   const inspected = await Promise.all(
      [...candidates].map(async (oid) => {
         const type = await runGit(ctx, ['cat-file', '-t', oid], { allowFailure: true });
         return { oid, type: type.exitCode === 0 ? text(type.stdout) : '' };
      })
   );
   const capsuleRef = `refs/gdx/history/keep/${manifest.id}`;
   const commits = inspected.filter((entry) => entry.type === 'commit').map((entry) => entry.oid);
   const manifestBlob = text(
      (await runGit(ctx, ['hash-object', '-w', '--stdin'], { input: stableStringify(manifest) })).stdout
   );
   const payloadOids = new Set<string>();
   const indexTreeOids = new Set<string>();
   for (const change of manifest.paths ?? []) {
      for (const state of [change.before, change.after]) {
         if ((state.kind === 'file' || state.kind === 'symlink') && state.oid) {
            payloadOids.add(state.oid);
         }
      }
   }
   const artifacts: HistoryArtifactReference[] = [];
   if (manifest.index) {
      for (const recipe of [manifest.index.undo, manifest.index.redo]) {
         if (!recipe) continue;
         if (recipe.kind === 'tree') {
            indexTreeOids.add(recipe.treeOid);
            continue;
         }
         if (recipe.kind === 'raw') artifacts.push(recipe.blob);
         else artifacts.push(...recipe.blobs.map((item) => item.blob));
      }
   }
   if (manifest.control) artifacts.push(...manifest.control.artifacts);
   for (const artifact of artifacts) {
      const oid = text(
         (await runGit(ctx, ['hash-object', '-w', '--stdin'], { input: await readArtifact(ctx, artifact) })).stdout
      );
      payloadOids.add(oid);
   }
   const treeInput = [
      `100644 blob ${manifestBlob}\tmanifest.json`,
      ...[...payloadOids]
         .sort()
         .map((oid, index) => `100644 blob ${oid}\tpayload-${String(index).padStart(4, '0')}`),
      ...[...indexTreeOids]
         .sort()
         .map((oid, index) => `040000 tree ${oid}\tindex-tree-${String(index).padStart(4, '0')}`),
   ].join('\n') + '\n';
   const tree = text(
      (
         await runGit(ctx, ['mktree'], {
            input: treeInput,
         })
      ).stdout
   );
   const commitArgs = [
      '-c',
      'user.name=gdx history',
      '-c',
      'user.email=history@localhost',
      'commit-tree',
      tree,
   ];
   for (const oid of commits) commitArgs.push('-p', oid);
   const capsule = text(
      (
         await runGit(ctx, commitArgs, {
            input: `gdx history capsule ${manifest.id}\n`,
         })
      ).stdout
   );
   await runGit(ctx, ['update-ref', capsuleRef, capsule]);
   await Promise.all(
      inspected
         .filter((entry) => entry.type === 'tag')
         .map((entry, index) =>
            runGit(ctx, [
               'update-ref',
               `refs/gdx/history/keep/${manifest.id}-tag-${index}`,
               entry.oid,
            ])
         )
   );
}

/** Returns a SHA-256 hex digest for durable payload verification. */
function sha256(value: Uint8Array | string): string {
   return crypto.createHash('sha256').update(value).digest('hex');
}

/** Builds the journal fingerprint shape used by repository surfaces. */
function fingerprint(value: Uint8Array | string): HistoryFingerprint {
   return { algorithm: 'sha256', value: sha256(value) };
}

/** Deterministically serializes plain journal values. */
function stableStringify(value: unknown): string {
   const normalize = (input: unknown): unknown => {
      if (Array.isArray(input)) return input.map(normalize);
      if (input && typeof input === 'object' && !Buffer.isBuffer(input)) {
         return Object.fromEntries(
            Object.entries(input as Record<string, unknown>)
               .sort(([left], [right]) => left.localeCompare(right))
               .map(([key, nested]) => [key, normalize(nested)])
         );
      }
      return input;
   };
   return JSON.stringify(normalize(value));
}

/** Compares journal values structurally without object identity. */
function equal(left: unknown, right: unknown): boolean {
   return stableStringify(left) === stableStringify(right);
}

/** Converts Git's binary output to a trimmed UTF-8 token. */
function text(value: Uint8Array): string {
   return Buffer.from(value).toString('utf8').trim();
}

/** Splits a NUL-delimited Git response while preserving raw path bytes. */
function splitNull(value: Uint8Array): Buffer[] {
   const bytes = Buffer.from(value);
   const records: Buffer[] = [];
   let start = 0;
   for (let index = 0; index < bytes.length; index++) {
      if (bytes[index] !== 0) continue;
      if (index > start) records.push(bytes.subarray(start, index));
      start = index + 1;
   }
   if (start < bytes.length) records.push(bytes.subarray(start));
   return records;
}

/** Reads a candidate file, treating an absent index/shared-index as empty. */
async function readOptionalFile(filePath: string): Promise<Buffer> {
   if (!filePath) return Buffer.alloc(0);
   return await fs.readFile(filePath).catch((error: unknown) => {
      if (fileSystemError(error, 'ENOENT')) return Buffer.alloc(0);
      throw error;
   });
}

/** Creates a lossless persisted path identity. */
function rawPathInfo(rawPath: Buffer, tracked: boolean): HistoryRawPath {
   return {
      bytesBase64: rawPath.toString('base64'),
      display: rawPath.toString('utf8'),
      tracked,
   };
}

/** Returns the canonical absent-path marker. */
function absentPathState(): HistoryPathState {
   return { kind: 'absent', mode: null, size: null, oid: null, fingerprint: null };
}

/** Returns a neutral HEAD value for plans that do not inspect refs. */
function emptyHeadState(): HistoryHeadState {
   return { value: { kind: 'missing' }, unborn: true };
}

/** Returns a neutral index value for plans that do not inspect the index. */
function emptyCandidateIndex(): CandidateIndex {
   return {
      state: { treeOid: null, entryCount: 0, fingerprint: EMPTY_FINGERPRINT },
      raw: Buffer.alloc(0),
      shared: [],
      canUseTree: false,
      entries: new Map(),
   };
}

/** Returns a neutral control-state value for plans that do not inspect sequencers. */
function emptyControlState(): CapturedControl {
   return {
      state: {
         kind: 'none',
         inProgress: false,
         headName: null,
         originalHead: null,
         step: null,
         totalSteps: null,
         fingerprint: EMPTY_FINGERPRINT,
      },
      files: [],
   };
}

/** Restricts stage entries to explicit pathspecs when the route supplied them. */
function filterIndexEntries(
   entries: Map<string, IndexEntry[]>,
   pathspecs: readonly string[]
): Map<string, IndexEntry[]> {
   if (!pathspecs.length) return entries;
   return new Map(
      [...entries].filter(([, values]) =>
         values.some((entry) => matchesAnyPathspec(entry.path.display, pathspecs))
      )
   );
}

/** Performs conservative literal/glob matching for routed pathspec capture. */
function matchesAnyPathspec(candidate: string, pathspecs: readonly string[]): boolean {
   if (!pathspecs.length) return true;
   const normalizedCandidate = candidate.replaceAll('\\', '/');
   return pathspecs.some((raw) => {
      let pattern = raw.replaceAll('\\', '/');
      pattern = pattern.replace(/^:\((?:literal|top,literal)\)/, '');
      pattern = pattern.replace(/^:\//, '');
      if (!/[?*[]/.test(pattern)) {
         const literal = pattern.replace(/^\.\//, '').replace(/\/$/, '');
         return normalizedCandidate === literal || normalizedCandidate.startsWith(`${literal}/`);
      }
      const escaped = pattern
         .replace(/[.+^${}()|\\]/g, '\\$&')
         .replaceAll('**', '\0')
         .replaceAll('*', '[^/]*')
         .replaceAll('?', '[^/]')
         .replaceAll('\0', '.*');
      return new RegExp(`^${escaped}$`).test(normalizedCandidate);
   });
}

/** Resolves a persisted relative path and rejects traversal/absolute paths. */
function safeRepoPath(root: string, filePath: HistoryRawPath): string {
   const relative = Buffer.from(filePath.bytesBase64, 'base64').toString('utf8');
   if (!relative || path.isAbsolute(relative) || relative.includes('\0')) {
      throw new Error(`Unsafe history path: ${filePath.display}`);
   }
   return safeDescendant(root, relative, 'history path');
}

/** Resolves one permitted control-state path below the per-worktree Git dir. */
function safeControlPath(gitDir: string, relative: string): string {
   const normalized = relative.replaceAll('\\', '/');
   const root = normalized.split('/')[0];
   if (!(CONTROL_ROOTS as readonly string[]).includes(root)) {
      throw new Error(`Unsafe history control path: ${relative}`);
   }
   return safeDescendant(gitDir, normalized, 'history control path');
}

/** Resolves an artifact path below the common history directory. */
function safeArtifactPath(historyDir: string, relative: string): string {
   return safeDescendant(historyDir, relative.replaceAll('\\', '/'), 'history artifact path');
}

/** Resolves a relative descendant while preventing path traversal. */
function safeDescendant(root: string, relative: string, label: string): string {
   const resolvedRoot = path.resolve(root);
   const target = path.resolve(resolvedRoot, ...relative.split('/'));
   if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new Error(`Unsafe ${label}: ${relative}`);
   }
   return target;
}

/** Tests a Node filesystem error code without weakening strict typing. */
function fileSystemError(error: unknown, code: string): boolean {
   return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code;
}

/** Reads a UTF-8 control value by exact path or basename. */
function readControlText(files: ControlFile[], name: string): string | null {
   const file = files.find((candidate) => candidate.path === name || path.posix.basename(candidate.path) === name);
   if (!file) return null;
   return Buffer.from(file.bytesBase64, 'base64').toString('utf8').trim() || null;
}

/** Reads an integer control value when Git persisted one. */
function readControlNumber(files: ControlFile[], name: string): number | null {
   const raw = readControlText(files, name);
   if (!raw || !/^\d+$/.test(raw)) return null;
   return Number(raw);
}

/** Extracts an exit code from routed command return values. */
function resultExitCode(value: unknown): number {
   return typeof value === 'number' && Number.isInteger(value) ? value : 0;
}

/** Extracts an exit code from a thrown process error. */
function errorExitCode(error: unknown): number {
   if (error && typeof error === 'object') {
      const code = (error as { exitCode?: unknown }).exitCode;
      if (typeof code === 'number' && Number.isInteger(code)) return code;
   }
   return 1;
}

/** Validates a positive multi-step undo/redo count. */
function normalizeCount(count = 1): number {
   if (!Number.isInteger(count) || count < 1) {
      throw new Error('History count must be a positive integer.');
   }
   return count;
}

/** Atomically replaces a binary journal payload. */
async function atomicWrite(filePath: string, bytes: Uint8Array): Promise<void> {
   await fs.mkdir(path.dirname(filePath), { recursive: true });
   const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
   try {
      await fs.writeFile(temporary, bytes, { flag: 'wx' });
      await fs.rename(temporary, filePath);
   } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
   }
}
