import { createHash, randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';

import { GdxContext } from '@/common/types';
import {
   readHistoryTransactionManifest,
   recordHistoryTransaction,
   resolveHistoryStoragePaths,
} from '@/modules/history/storage';
import { $ } from '@/modules/shell';
import { createTransactionCapsule } from '@/modules/history/transaction';
import {
   HISTORY_SCHEMA_VERSION,
   type HistoryCapability,
   type HistoryRefChange,
   type HistoryRefState,
   type HistoryRepositoryFingerprint,
   type HistorySource,
   type HistoryStoragePaths,
   type HistoryTransactionManifest,
} from '@/modules/history/types';

const HOOK_NAME = 'reference-transaction';
const MANAGED_MARKER = '# gdx-history-reference-transaction-v1';
const MANAGED_METADATA_FILE = 'reference-transaction-hook.json';
const ORIGINAL_HOOK_FILE = 'reference-transaction.original';
const HOOK_SPOOL_DIR = 'reference-transaction-spool';
const REFLOG_SPOOL_DIR = 'reflog-spool';
const REFLOG_METADATA_FILE = 'reflog-checkpoint.json';
const MIN_REFERENCE_TRANSACTION_VERSION = [2, 29, 0] as const;
const PRIVATE_REF_PREFIX = 'refs/gdx/history/';
const MAX_STORED_DEDUPE_KEYS = 4096;
const OBSERVED_REFLOG_MATCH_WINDOW_MS = 5 * 60 * 1000;

/** Provenance literals persisted by the direct observer. */
export type HistoryObservedSource = Extract<HistorySource, 'git-hook' | 'reflog'>;

/** Capability literals used by observer/reflog records. */
export type HistoryObservedCapability = HistoryCapability;

/** A ref-only transaction waiting to be added to the main history journal. */
export interface HistoryObservedRefTransaction {
   schemaVersion: typeof HISTORY_SCHEMA_VERSION;
   id: string;
   createdAt: string;
   source: HistoryObservedSource;
   capability: HistoryObservedCapability;
   refs: HistoryRefChange[];
   cwd: string;
   message: string | null;
   dedupeKey: string;
}

/** Result returned by the fail-open hook entry helper. */
export interface HistoryObserverHookResult {
   recorded: boolean;
   ignoredReason?: 'guarded' | 'phase' | 'empty' | 'invalid' | 'error';
   transaction?: HistoryObservedRefTransaction;
}

/** Options accepted by the hook installer. */
export interface HistoryObserverInstallOptions {
   /** Command prefix used by the wrapper to enter GDX. Primarily useful for tests. */
   observerCommand?: string[];
}

/** Current state of the managed reference-transaction hook. */
export interface HistoryObserverStatus {
   state: 'not-installed' | 'installed' | 'modified' | 'unsupported' | 'custom-hooks-path';
   hookPath: string | null;
   hasExistingHook: boolean;
   message: string;
}

/** Summary of an explicit reflog reconciliation pass. */
export interface HistoryReflogReconciliationResult {
   imported: HistoryObservedRefTransaction[];
   skippedDuplicate: number;
   skippedMalformed: number;
}

interface ManagedHookMetadata {
   version: 1;
   hookPath: string;
   wrapperHash: string;
   observerCommand: string[];
   installedAt: string;
   original: {
      backupPath: string;
      hash: string;
      mode: number;
      executable: boolean;
   } | null;
}

interface HookEntryOptions {
   observerDir: string;
   stdin?: Buffer | string;
   cwd?: string;
   env?: NodeJS.ProcessEnv;
}

interface ReflogCheckpoint {
   offset: number;
   lastLineHash: string | null;
}

interface ReflogMetadata {
   version: 1;
   updatedAt: string;
   checkpoints: Record<string, ReflogCheckpoint>;
   seenKeys: string[];
}

interface ParsedReflogEntry {
   oldOid: string;
   newOid: string;
   timestampMs: number;
   message: string;
}

interface KnownTransition {
   timestampMs: number;
   remaining: number;
}

/**
 * Verifies that the configured Git executable is new enough to implement the
 * reference-transaction hook. This check performs no repository mutation.
 * @param ctx - GDX context containing the repository-aware Git command.
 * @returns The parsed Git version.
 */
export async function verifyReferenceTransactionSupport(
   ctx: GdxContext
): Promise<{ major: number; minor: number; patch: number; raw: string }> {
   const result = await runGit(ctx, ['--version']);
   const raw = result.stdout.trim();
   const match = raw.match(/(?:git version\s+)?(\d+)\.(\d+)(?:\.(\d+))?/i);
   if (!match) {
      throw new Error(`Unable to verify reference-transaction support from: ${raw || 'no output'}`);
   }

   const version = {
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3] ?? 0),
      raw,
   };
   if (compareVersion(version, MIN_REFERENCE_TRANSACTION_VERSION) < 0) {
      throw new Error(
         `Git ${version.major}.${version.minor}.${version.patch} does not support the ` +
            `reference-transaction hook; Git 2.29.0 or newer is required.`
      );
   }
   return version;
}

/**
 * Installs GDX's managed repository-local reference-transaction hook.
 * Existing hook bytes are retained in the common history directory and are
 * invoked by the wrapper with the same arguments, stdin, output, and status.
 * @param ctx - GDX context for the target repository.
 * @param options - Optional hook-entry command override.
 * @returns The resulting observer status.
 */
export async function installHistoryObserverHook(
   ctx: GdxContext,
   options: HistoryObserverInstallOptions = {}
): Promise<HistoryObserverStatus> {
   // This must stay before every target-repository filesystem mutation.
   await verifyReferenceTransactionSupport(ctx);
   const paths = await resolveHistoryStoragePaths(ctx.git$);
   const customHooksPath = await readCustomHooksPath(ctx);
   if (customHooksPath) throw customHooksPathError(customHooksPath);

   const hookPath = path.join(paths.commonGitDir, 'hooks', HOOK_NAME);
   const metadataPath = path.join(paths.observersDir, MANAGED_METADATA_FILE);
   const backupPath = path.join(paths.observersDir, ORIGINAL_HOOK_FILE);
   const existingMetadata = await readManagedMetadata(metadataPath);
   if (existingMetadata) {
      const status = await inspectManagedHook(existingMetadata, hookPath);
      if (status.state === 'installed') return status;
      throw new Error(status.message);
   }

   const existingBytes = await readFileIfPresent(hookPath);
   if (existingBytes?.includes(Buffer.from(MANAGED_MARKER))) {
      throw new Error(
         'The reference-transaction hook looks GDX-managed but its metadata is missing. ' +
            'Refusing to replace it; restore or remove it manually after inspection.'
      );
   }
   if (await fileExists(backupPath)) {
      throw new Error(
         `Refusing to install because the unmanaged backup already exists at ${backupPath}.`
      );
   }

   const command = options.observerCommand ?? defaultHistoryObserverCommand();
   if (!command.length || command.some((part) => part.includes('\0'))) {
      throw new Error('Observer command must contain at least one NUL-free argument.');
   }

   const existingStat = existingBytes ? await fs.stat(hookPath) : null;
   const original =
      existingBytes && existingStat
         ? {
              backupPath,
              hash: hashBytes(existingBytes),
              mode: existingStat.mode,
              executable: (existingStat.mode & 0o111) !== 0,
           }
         : null;
   const wrapper = renderManagedWrapper(command, paths.spoolDir, original);
   const metadata: ManagedHookMetadata = {
      version: 1,
      hookPath,
      wrapperHash: hashBytes(wrapper),
      observerCommand: command,
      installedAt: new Date().toISOString(),
      original,
   };

   await fs.mkdir(path.dirname(hookPath), { recursive: true });
   await fs.mkdir(paths.observersDir, { recursive: true });

   let backupWritten = false;
   let metadataWritten = false;
   try {
      if (existingBytes && original) {
         await writeFileAtomic(backupPath, existingBytes, original.mode);
         backupWritten = true;
      }
      await writeJsonAtomic(metadataPath, metadata);
      metadataWritten = true;
      await writeFileAtomic(hookPath, wrapper, 0o100755);
   } catch (error) {
      // Only remove artifacts created by this attempt. Never touch the user's hook.
      if (metadataWritten) await fs.rm(metadataPath, { force: true }).catch(() => undefined);
      if (backupWritten) await fs.rm(backupPath, { force: true }).catch(() => undefined);
      throw error;
   }

   return inspectManagedHook(metadata, hookPath);
}

/**
 * Builds the hook entry command from the current executable invocation.
 * Script-based development/package runs need both the runtime and entry script;
 * native compiled binaries can re-enter through process.execPath alone.
 */
export function defaultHistoryObserverCommand(argv = process.argv): string[] {
   const entry = argv[1];
   const entryName = entry ? path.basename(entry).toLowerCase() : '';
   const scriptEntryNames = new Set(['index.ts', 'index.js', 'launcher.cjs']);
   const command =
      entry && scriptEntryNames.has(entryName)
         ? [process.execPath, path.resolve(entry)]
         : [process.execPath];
   return [...command, 'history', '__hook-entry'];
}

/**
 * Removes the managed hook and atomically restores any original hook bytes.
 * Externally modified wrappers and backups are deliberately left untouched.
 * @param ctx - GDX context for the target repository.
 * @returns The resulting observer status.
 */
export async function uninstallHistoryObserverHook(
   ctx: GdxContext
): Promise<HistoryObserverStatus> {
   const paths = await resolveHistoryStoragePaths(ctx.git$);
   const customHooksPath = await readCustomHooksPath(ctx);
   if (customHooksPath) throw customHooksPathError(customHooksPath);

   const hookPath = path.join(paths.commonGitDir, 'hooks', HOOK_NAME);
   const metadataPath = path.join(paths.observersDir, MANAGED_METADATA_FILE);
   const metadata = await readManagedMetadata(metadataPath);
   if (!metadata) {
      return {
         state: 'not-installed',
         hookPath,
         hasExistingHook: await fileExists(hookPath),
         message: 'The GDX history observer hook is not installed.',
      };
   }

   const current = await inspectManagedHook(metadata, hookPath);
   if (current.state !== 'installed') throw new Error(current.message);

   if (metadata.original) {
      const backup = await readFileIfPresent(metadata.original.backupPath);
      if (!backup || hashBytes(backup) !== metadata.original.hash) {
         throw new Error(
            'The saved original reference-transaction hook was modified or removed. ' +
               'Refusing to restore it automatically.'
         );
      }
      await writeFileAtomic(hookPath, backup, metadata.original.mode);
   } else {
      await removeFileAtomically(hookPath);
   }

   await fs.rm(metadataPath, { force: true });
   if (metadata.original) await fs.rm(metadata.original.backupPath, { force: true });
   return {
      state: 'not-installed',
      hookPath,
      hasExistingHook: metadata.original !== null,
      message: metadata.original
         ? 'The GDX history observer was removed and the original hook was restored.'
         : 'The GDX history observer hook was removed.',
   };
}

/**
 * Reports whether the repository has a healthy managed observer hook.
 * @param ctx - GDX context for the target repository.
 * @returns Observer status without changing repository files.
 */
export async function getHistoryObserverHookStatus(
   ctx: GdxContext
): Promise<HistoryObserverStatus> {
   let supportError: Error | null = null;
   try {
      await verifyReferenceTransactionSupport(ctx);
   } catch (error) {
      supportError = error instanceof Error ? error : new Error(String(error));
   }

   const paths = await resolveHistoryStoragePaths(ctx.git$);
   const hookPath = path.join(paths.commonGitDir, 'hooks', HOOK_NAME);
   const customHooksPath = await readCustomHooksPath(ctx);
   if (customHooksPath) {
      return {
         state: 'custom-hooks-path',
         hookPath,
         hasExistingHook: false,
         message: customHooksPathError(customHooksPath).message,
      };
   }
   if (supportError) {
      return {
         state: 'unsupported',
         hookPath,
         hasExistingHook: await fileExists(hookPath),
         message: supportError.message,
      };
   }

   const metadata = await readManagedMetadata(path.join(paths.observersDir, MANAGED_METADATA_FILE));
   if (!metadata) {
      const bytes = await readFileIfPresent(hookPath);
      return {
         state: bytes?.includes(Buffer.from(MANAGED_MARKER)) ? 'modified' : 'not-installed',
         hookPath,
         hasExistingHook: bytes !== null,
         message: bytes?.includes(Buffer.from(MANAGED_MARKER))
            ? 'A GDX-looking hook exists without valid management metadata.'
            : 'The GDX history observer hook is not installed.',
      };
   }
   return inspectManagedHook(metadata, hookPath);
}

/**
 * Handles one reference-transaction hook invocation. Only the `committed`
 * phase is persisted, and all failures are converted to a fail-open result so
 * the original Git operation cannot be failed by observer bookkeeping.
 * @param phase - Git's hook phase (`prepared`, `committed`, or `aborted`).
 * @param options - Observer directory, optional stdin, cwd, and environment.
 * @returns Whether one committed batch was durably spooled.
 */
export async function runHistoryObserverHookEntry(
   phase: string,
   options: HookEntryOptions
): Promise<HistoryObserverHookResult> {
   try {
      const env = options.env ?? process.env;
      if (env.GDX_HISTORY_GUARD === '1') {
         return { recorded: false, ignoredReason: 'guarded' };
      }
      if (phase !== 'committed') return { recorded: false, ignoredReason: 'phase' };

      const input = options.stdin === undefined ? await readStdin() : Buffer.from(options.stdin);
      if (input.length === 0) return { recorded: false, ignoredReason: 'empty' };
      const refs = parseReferenceTransactionInput(input);
      if (!refs.length) return { recorded: false, ignoredReason: 'invalid' };

      const createdAt = new Date().toISOString();
      const transaction = createObservedTransaction({
         createdAt,
         source: 'git-hook',
         capability: classifyHookCapability(refs),
         refs,
         cwd: options.cwd ?? process.cwd(),
         message: null,
      });
      await appendObservedTransaction(options.observerDir, HOOK_SPOOL_DIR, transaction);
      return { recorded: true, transaction };
   } catch {
      return { recorded: false, ignoredReason: 'error' };
   }
}

/**
 * Explicitly reconciles ref-only events from common-dir reflogs. This function
 * is never called automatically; command handling must opt into it directly.
 * Checkpoints advance only after an event is skipped safely or durably spooled.
 * @param ctx - GDX context for the repository being reconciled.
 * @returns Imported inferred transactions and skip counters.
 */
export async function reconcileHistoryReflogs(
   ctx: GdxContext
): Promise<HistoryReflogReconciliationResult> {
   const paths = await resolveHistoryStoragePaths(ctx.git$);
   const reflogRoot = path.join(paths.commonGitDir, 'logs', 'refs');
   const metadataPath = path.join(paths.observersDir, REFLOG_METADATA_FILE);
   const hadCheckpointMetadata = await fileExists(metadataPath);
   const metadata = await readReflogMetadata(metadataPath);
   const managed = hadCheckpointMetadata
      ? null
      : await readManagedMetadata(path.join(paths.observersDir, MANAGED_METADATA_FILE));
   const firstScanCutoff = hadCheckpointMetadata
      ? Number.NEGATIVE_INFINITY
      : managed
        ? Date.parse(managed.installedAt)
        : Date.now();
   const knownTransitions = await collectKnownTransitions(paths);
   const imported: HistoryObservedRefTransaction[] = [];
   let skippedDuplicate = 0;
   let skippedMalformed = 0;

   const files = await listFilesRecursively(reflogRoot);
   for (const file of files) {
      const relative = path
         .relative(path.join(paths.commonGitDir, 'logs'), file)
         .split(path.sep)
         .join('/');
      if (!isStrictRefName(relative) || isPrivateHistoryRef(relative)) continue;

      const bytes = await fs.readFile(file).catch(() => null);
      if (!bytes) continue; // Expired/deleted reflogs never synthesize an event.
      let checkpoint = validateCheckpoint(bytes, metadata.checkpoints[relative]);
      const lines = completeLinesFrom(bytes, checkpoint.offset);
      for (const line of lines) {
         const parsed = parseReflogLine(line.bytes);
         if (!parsed || parsed.oldOid === parsed.newOid) {
            if (!parsed) skippedMalformed++;
            checkpoint = checkpointAfterLine(line);
            continue;
         }
         if (parsed.timestampMs < firstScanCutoff) {
            checkpoint = checkpointAfterLine(line);
            continue;
         }

         const refs = [oidRefChange(relative, parsed.oldOid, parsed.newOid)];
         const dedupeKey = transitionDedupeKey(refs);
         const eventKey = reflogEventKey(relative, parsed);
         if (
            metadata.seenKeys.includes(eventKey) ||
            consumeKnownTransition(knownTransitions, dedupeKey, parsed.timestampMs)
         ) {
            skippedDuplicate++;
            metadata.seenKeys.push(eventKey);
            checkpoint = checkpointAfterLine(line);
            continue;
         }

         const transaction = createObservedTransaction({
            createdAt: new Date(parsed.timestampMs).toISOString(),
            source: 'reflog',
            capability: 'inferred',
            refs,
            cwd: paths.root,
            message: parsed.message,
         });
         await appendObservedTransaction(paths.spoolDir, REFLOG_SPOOL_DIR, transaction);
         imported.push(transaction);
         metadata.seenKeys.push(eventKey);
         checkpoint = checkpointAfterLine(line);
      }
      metadata.checkpoints[relative] = checkpoint;
   }

   metadata.seenKeys = [...new Set(metadata.seenKeys)].slice(-MAX_STORED_DEDUPE_KEYS);
   metadata.updatedAt = new Date().toISOString();
   await fs.mkdir(paths.observersDir, { recursive: true });
   await writeJsonAtomic(metadataPath, metadata);
   return { imported, skippedDuplicate, skippedMalformed };
}

/**
 * Reads pending hook and reflog spool records without deleting them.
 * @param ctx - GDX context for the repository.
 * @returns Pending records ordered by creation time and stable ID.
 */
export async function readHistoryObserverSpool(
   ctx: GdxContext
): Promise<HistoryObservedRefTransaction[]> {
   const paths = await resolveHistoryStoragePaths(ctx.git$);
   const records = await readObservedTransactions(paths.spoolDir);
   return records.sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
   );
}

/**
 * Imports pending hook/reflog ref batches into the current worktree timeline.
 * This is intentionally explicit so normal dispatch and hook execution never
 * perform reconciliation or journal reads.
 * @param ctx - Direct history-command context.
 * @param maxEntries - Per-worktree retention limit.
 * @returns Newly imported manifests.
 */
export async function importHistoryObserverSpool(
   ctx: GdxContext,
   maxEntries = 100
): Promise<HistoryTransactionManifest[]> {
   const paths = await resolveHistoryStoragePaths(ctx.git$);
   const files = [
      ...(await listJsonFiles(path.join(paths.spoolDir, HOOK_SPOOL_DIR))),
      ...(await listJsonFiles(path.join(paths.spoolDir, REFLOG_SPOOL_DIR))),
   ];
   const pending: Array<{ file: string; record: HistoryObservedRefTransaction }> = [];
   for (const file of files) {
      const parsed = await readJsonIfPresent(file);
      if (isObservedTransaction(parsed)) pending.push({ file, record: parsed });
   }
   pending.sort(
      (left, right) =>
         left.record.createdAt.localeCompare(right.record.createdAt) ||
         left.record.id.localeCompare(right.record.id)
   );

   const imported: HistoryTransactionManifest[] = [];
   for (const { file, record } of pending) {
      const existing = await readHistoryTransactionManifest(ctx.git$, record.id).catch(() => null);
      if (existing) {
         await createTransactionCapsule(ctx, existing);
         await fs.rm(file, { force: true });
         continue;
      }
      const before = observerFingerprint(record.refs, 'before');
      const after = observerFingerprint(record.refs, 'after');
      const result = await recordHistoryTransaction(
         ctx.git$,
         {
            id: record.id,
            createdAt: record.createdAt,
            source: record.source,
            capability: record.capability,
            command: record.message
               ? {
                    command: record.message,
                    argv: [],
                    cwd: record.cwd,
                    startedAt: record.createdAt,
                    finishedAt: record.createdAt,
                    exitCode: 0,
                 }
               : undefined,
            refs: record.refs,
            fingerprints: { before, after },
            undoUnavailableReason:
               record.capability === 'audit-only'
                  ? 'The direct observer did not receive enough state to restore this action.'
                  : undefined,
         },
         { maxEntries }
      );
      imported.push(result.manifest);
      if (result.timeline.entries.includes(result.manifest.id)) {
         await createTransactionCapsule(ctx, result.manifest);
      }
      await fs.rm(file, { force: true });
   }
   return imported;
}

/** Builds strict ref-only divergence fingerprints for an observed batch. */
function observerFingerprint(
   refs: HistoryRefChange[],
   side: 'before' | 'after'
): HistoryRepositoryFingerprint {
   const empty = { algorithm: 'sha256' as const, value: hashText('') };
   const refFingerprint = {
      algorithm: 'sha256' as const,
      value: hashText(
         stableObserverStringify(refs.map((change) => [change.name, change[side]]))
      ),
   };
   return {
      refs: refFingerprint,
      head: empty,
      index: empty,
      paths: empty,
      control: empty,
      combined: {
         algorithm: 'sha256',
         value: hashText(`${refFingerprint.value}\0${empty.value}`),
      },
   };
}

/** Matches the transaction engine's deterministic plain-object serialization. */
function stableObserverStringify(value: unknown): string {
   const normalize = (input: unknown): unknown => {
      if (Array.isArray(input)) return input.map(normalize);
      if (input && typeof input === 'object') {
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

/** Parses one committed hook input batch into changed ref records. */
function parseReferenceTransactionInput(input: Buffer): HistoryRefChange[] {
   const changes = new Map<string, HistoryRefChange>();
   for (const rawLine of input.toString('utf8').split('\n')) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line) continue;
      const match = line.match(/^(\S+) (\S+) (\S+)$/);
      if (!match) continue;
      const [, oldValue, newValue, name] = match;
      if ((!isStrictRefName(name) && name !== 'HEAD') || isPrivateHistoryRef(name)) continue;
      const before = parseHookRefValue(oldValue);
      const after = parseHookRefValue(newValue);
      if (before === undefined || after === undefined || equalRefState(before, after)) continue;

      const existing = changes.get(name);
      changes.set(name, {
         name,
         before: existing?.before ?? before,
         after,
      });
   }
   return [...changes.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Converts an OID or `ref:` hook token to the strict history ref shape. */
function parseHookRefValue(value: string): HistoryRefState | undefined {
   if (/^0{40}$/.test(value) || /^0{64}$/.test(value)) return { kind: 'missing' };
   if (/^[0-9a-f]{40}$/.test(value) || /^[0-9a-f]{64}$/.test(value)) {
      return { kind: 'oid', oid: value };
   }
   if (value.startsWith('ref:')) {
      const target = value.slice(4);
      if (!isStrictRefName(target)) return undefined;
      return { kind: 'symbolic', target, oid: null };
   }
   return undefined;
}

/** Determines the honest capability of a direct hook ref batch. */
function classifyHookCapability(refs: HistoryRefChange[]): HistoryObservedCapability {
   const isUnambiguouslyRefOnly = refs.every((change) => {
      if (change.name.startsWith('refs/tags/') || change.name.startsWith('refs/remotes/')) {
         return true;
      }
      if (change.name.startsWith('refs/heads/')) {
         return change.before.kind === 'missing' || change.after.kind === 'missing';
      }
      return false;
   });
   return isUnambiguouslyRefOnly ? 'exact' : 'conditional';
}

/** Builds a stable persisted observer transaction. */
function createObservedTransaction(
   input: Omit<HistoryObservedRefTransaction, 'schemaVersion' | 'id' | 'dedupeKey'>
): HistoryObservedRefTransaction {
   const dedupeKey = transitionDedupeKey(input.refs);
   const idSeed = `${input.source}\0${input.createdAt}\0${dedupeKey}\0${randomUUID()}`;
   return {
      schemaVersion: HISTORY_SCHEMA_VERSION,
      id: `${input.source}-${hashText(idSeed).slice(0, 24)}`,
      dedupeKey,
      ...input,
   };
}

/** Writes one immutable spool record via same-directory atomic rename. */
async function appendObservedTransaction(
   observerDir: string,
   spoolName: string,
   transaction: HistoryObservedRefTransaction
): Promise<void> {
   const spoolDir = path.join(observerDir, spoolName);
   await fs.mkdir(spoolDir, { recursive: true });
   await writeJsonAtomic(path.join(spoolDir, `${transaction.id}.json`), transaction, true);
}

/** Executes Git through the context-provided executable. */
async function runGit(
   ctx: GdxContext,
   args: string[],
   reject = true
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
   const result = await $({ reject: false })`${ctx.git$} ${args}`;
   const output = {
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
      exitCode: result.exitCode ?? 0,
   };
   if (reject && output.exitCode !== 0) {
      throw new Error(
         output.stderr.trim() || output.stdout.trim() || `Git exited ${output.exitCode}.`
      );
   }
   return output;
}

/** Reads an explicitly configured effective hooksPath. */
async function readCustomHooksPath(ctx: GdxContext): Promise<string | null> {
   const result = await runGit(ctx, ['config', '--path', '--get', 'core.hooksPath'], false);
   return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

/** Produces actionable guidance without modifying a custom/shared hook path. */
function customHooksPathError(customPath: string): Error {
   return new Error(
      `core.hooksPath is configured as "${customPath}". GDX will not rewrite a custom/shared ` +
         'hook directory. Manually chain `gdx history __hook-entry` from its ' +
         'reference-transaction hook, passing the phase arguments and an identical copy of stdin.'
   );
}

/** Renders the fail-open POSIX wrapper executed by Git for all platforms. */
function renderManagedWrapper(
   command: string[],
   observerDir: string,
   original: ManagedHookMetadata['original']
): Buffer {
   const observerInvocation = [...command, '--observer-dir', observerDir]
      .map(quoteShellArgument)
      .join(' ');
   const originalInvocation = original?.executable
      ? `${quoteShellArgument(original.backupPath)} "$@" <"$gdx_input"\n` +
        'gdx_original_status=$?\n'
      : 'gdx_original_status=0\n';
   const fallback = original?.executable
      ? `exec ${quoteShellArgument(original.backupPath)} "$@"`
      : 'exit 0';
   return Buffer.from(
      '#!/bin/sh\n' +
         `${MANAGED_MARKER}\n` +
         'gdx_input="${TMPDIR:-/tmp}/gdx-history-hook-$$-${PPID:-0}"\n' +
         'umask 077\n' +
         `if ! ( : >"$gdx_input" ); then ${fallback}; fi\n` +
         `if ! cat >"$gdx_input"; then rm -f "$gdx_input"; ${fallback}; fi\n` +
         'trap \'rm -f "$gdx_input"\' EXIT HUP INT TERM\n' +
         originalInvocation +
         'if [ "$gdx_original_status" -eq 0 ]; then\n' +
         `  ${observerInvocation} "$@" <"$gdx_input" >/dev/null 2>&1 || :\n` +
         'fi\n' +
         'exit "$gdx_original_status"\n',
      'utf8'
   );
}

/** Inspects wrapper and backup fingerprints without altering either file. */
async function inspectManagedHook(
   metadata: ManagedHookMetadata,
   hookPath: string
): Promise<HistoryObserverStatus> {
   const hook = await readFileIfPresent(hookPath);
   const backup = metadata.original ? await readFileIfPresent(metadata.original.backupPath) : null;
   const hookValid = hook !== null && hashBytes(hook) === metadata.wrapperHash;
   const backupValid =
      metadata.original === null ||
      (backup !== null && hashBytes(backup) === metadata.original.hash);
   if (!hookValid || !backupValid || path.resolve(metadata.hookPath) !== path.resolve(hookPath)) {
      return {
         state: 'modified',
         hookPath,
         hasExistingHook: hook !== null,
         message:
            'The managed reference-transaction hook or its saved original was externally modified. ' +
            'Refusing automatic replacement/removal.',
      };
   }
   return {
      state: 'installed',
      hookPath,
      hasExistingHook: metadata.original !== null,
      message: 'The GDX history observer hook is installed.',
   };
}

/** Reads and minimally validates managed-hook metadata. */
async function readManagedMetadata(file: string): Promise<ManagedHookMetadata | null> {
   const parsed = await readJsonIfPresent(file);
   if (!parsed || typeof parsed !== 'object') return null;
   const value = parsed as Partial<ManagedHookMetadata>;
   if (
      value.version !== 1 ||
      typeof value.hookPath !== 'string' ||
      typeof value.wrapperHash !== 'string' ||
      !Array.isArray(value.observerCommand)
   )
      return null;
   return value as ManagedHookMetadata;
}

/** Parses one raw reflog line without asking Git to enrich it. */
function parseReflogLine(bytes: Buffer): ParsedReflogEntry | null {
   const text = bytes.toString('utf8').replace(/\r$/, '');
   const tab = text.indexOf('\t');
   if (tab < 0) return null;
   const header = text.slice(0, tab);
   const message = text.slice(tab + 1);
   const match = header.match(
      /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) .+ (\d+) ([+-]\d{4})$/
   );
   if (!match || match[1].length !== match[2].length) return null;
   const seconds = Number(match[3]);
   const timestampMs = seconds * 1000;
   if (!Number.isSafeInteger(seconds) || seconds <= 0 || timestampMs > Date.now() + 86_400_000) {
      return null;
   }
   return { oldOid: match[1], newOid: match[2], timestampMs, message };
}

/** Produces a strict ref-only change from a reflog line. */
function oidRefChange(name: string, oldOid: string, newOid: string): HistoryRefChange {
   return {
      name,
      before: /^0+$/.test(oldOid) ? { kind: 'missing' } : { kind: 'oid', oid: oldOid },
      after: /^0+$/.test(newOid) ? { kind: 'missing' } : { kind: 'oid', oid: newOid },
   };
}

/** Validates ref names using Git check-ref-format's one-level restrictions. */
function isStrictRefName(name: string): boolean {
   if (!name.startsWith('refs/') || name.length <= 5 || name.endsWith('/') || name.endsWith('.')) {
      return false;
   }
   if (
      name.includes('..') ||
      name.includes('@{') ||
      name.includes('//') ||
      /[\x00-\x20\x7f~^:?*\\[]/.test(name)
   )
      return false;
   return name
      .split('/')
      .every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'));
}

/** Checks whether a ref is reserved for GDX's retention/journal machinery. */
function isPrivateHistoryRef(name: string): boolean {
   return name.startsWith(PRIVATE_REF_PREFIX);
}

/** Reads reflog metadata or returns an empty checkpoint set. */
async function readReflogMetadata(file: string): Promise<ReflogMetadata> {
   const parsed = (await readJsonIfPresent(file)) as Partial<ReflogMetadata> | null;
   if (
      parsed?.version === 1 &&
      parsed.checkpoints &&
      typeof parsed.checkpoints === 'object' &&
      Array.isArray(parsed.seenKeys)
   )
      return parsed as ReflogMetadata;
   return { version: 1, updatedAt: new Date(0).toISOString(), checkpoints: {}, seenKeys: [] };
}

/** Validates an offset against the last complete line hash, handling expiry/rewrites. */
function validateCheckpoint(bytes: Buffer, checkpoint?: ReflogCheckpoint): ReflogCheckpoint {
   if (!checkpoint || checkpoint.offset < 0 || checkpoint.offset > bytes.length) {
      return { offset: 0, lastLineHash: null };
   }
   if (checkpoint.offset === 0) return { offset: 0, lastLineHash: null };
   if (bytes[checkpoint.offset - 1] !== 0x0a) return { offset: 0, lastLineHash: null };
   const priorNewline = bytes.lastIndexOf(0x0a, checkpoint.offset - 2);
   const previousLine = bytes.subarray(priorNewline + 1, checkpoint.offset - 1);
   if (hashBytes(previousLine) !== checkpoint.lastLineHash) {
      return { offset: 0, lastLineHash: null };
   }
   return checkpoint;
}

/** Extracts only newline-terminated records and their next durable offsets. */
function completeLinesFrom(
   bytes: Buffer,
   offset: number
): Array<{
   bytes: Buffer;
   nextOffset: number;
   hash: string;
}> {
   const lines: Array<{ bytes: Buffer; nextOffset: number; hash: string }> = [];
   let cursor = offset;
   while (cursor < bytes.length) {
      const newline = bytes.indexOf(0x0a, cursor);
      if (newline < 0) break;
      const line = bytes.subarray(cursor, newline);
      lines.push({ bytes: line, nextOffset: newline + 1, hash: hashBytes(line) });
      cursor = newline + 1;
   }
   return lines;
}

/** Converts one processed line to its durable checkpoint. */
function checkpointAfterLine(line: { nextOffset: number; hash: string }): ReflogCheckpoint {
   return { offset: line.nextOffset, lastLineHash: line.hash };
}

/** Collects routed/hook transitions for one-to-one reflog deduplication. */
async function collectKnownTransitions(
   paths: HistoryStoragePaths
): Promise<Map<string, KnownTransition[]>> {
   const map = new Map<string, KnownTransition[]>();
   const records = [
      ...(await readObservedTransactions(paths.spoolDir)),
      ...(await readTransactionManifests(paths.transactionsDir)),
   ];
   for (const record of records) {
      const timestampMs = Date.parse(record.createdAt);
      if (!Number.isFinite(timestampMs)) continue;
      for (const ref of record.refs) {
         const key = transitionDedupeKey([ref]);
         const entries = map.get(key) ?? [];
         entries.push({ timestampMs, remaining: 1 });
         map.set(key, entries);
      }
   }
   return map;
}

/** Consumes at most one nearby known transition, preserving repeated movements. */
function consumeKnownTransition(
   known: Map<string, KnownTransition[]>,
   key: string,
   timestampMs: number
): boolean {
   const candidates = known.get(key);
   if (!candidates) return false;
   const candidate = candidates.find(
      (entry) =>
         entry.remaining > 0 &&
         Math.abs(entry.timestampMs - timestampMs) <= OBSERVED_REFLOG_MATCH_WINDOW_MS
   );
   if (!candidate) return false;
   candidate.remaining--;
   return true;
}

/** Reads observer records below both spool directories. */
async function readObservedTransactions(
   observerDir: string
): Promise<HistoryObservedRefTransaction[]> {
   const files = [
      ...(await listJsonFiles(path.join(observerDir, HOOK_SPOOL_DIR))),
      ...(await listJsonFiles(path.join(observerDir, REFLOG_SPOOL_DIR))),
   ];
   const records: HistoryObservedRefTransaction[] = [];
   for (const file of files) {
      const parsed = await readJsonIfPresent(file);
      if (isObservedTransaction(parsed)) records.push(parsed);
   }
   return records;
}

/** Reads the minimum common shape from already-journaled manifests. */
async function readTransactionManifests(
   transactionDir: string
): Promise<Array<Pick<HistoryObservedRefTransaction, 'createdAt' | 'refs'>>> {
   const records: Array<Pick<HistoryObservedRefTransaction, 'createdAt' | 'refs'>> = [];
   for (const file of await listJsonFiles(transactionDir)) {
      const parsed = await readJsonIfPresent(file);
      if (!parsed || typeof parsed !== 'object') continue;
      const value = parsed as { createdAt?: unknown; refs?: unknown };
      if (typeof value.createdAt === 'string' && Array.isArray(value.refs)) {
         records.push({ createdAt: value.createdAt, refs: value.refs as HistoryRefChange[] });
      }
   }
   return records;
}

/** Checks the persisted observer-spool discriminants. */
function isObservedTransaction(value: unknown): value is HistoryObservedRefTransaction {
   if (!value || typeof value !== 'object') return false;
   const record = value as Partial<HistoryObservedRefTransaction>;
   return (
      record.schemaVersion === HISTORY_SCHEMA_VERSION &&
      typeof record.id === 'string' &&
      typeof record.createdAt === 'string' &&
      (record.source === 'git-hook' || record.source === 'reflog') &&
      ['exact', 'conditional', 'inferred', 'audit-only'].includes(record.capability ?? '') &&
      Array.isArray(record.refs)
   );
}

/** Produces an order-independent transition key for a ref batch. */
function transitionDedupeKey(refs: HistoryRefChange[]): string {
   const canonical = refs
      .map((change) =>
         [change.name, refStateToken(change.before), refStateToken(change.after)].join('\0')
      )
      .sort()
      .join('\n');
   return hashText(canonical);
}

/** Produces a durable identity for one raw reflog event. */
function reflogEventKey(ref: string, entry: ParsedReflogEntry): string {
   return hashText(
      `${ref}\0${entry.oldOid}\0${entry.newOid}\0${entry.timestampMs}\0${entry.message}`
   );
}

/** Serializes missing, OID, and symbolic ref states without ambiguity. */
function refStateToken(state: HistoryRefState): string {
   if (state.kind === 'missing') return 'missing';
   if (state.kind === 'symbolic') return `symbolic:${state.target}:${state.oid ?? ''}`;
   return `oid:${state.oid}`;
}

/** Compares two ref states. */
function equalRefState(a: HistoryRefState, b: HistoryRefState): boolean {
   return refStateToken(a) === refStateToken(b);
}

/** Lists all files below a directory, tolerating absent/expired paths. */
async function listFilesRecursively(root: string): Promise<string[]> {
   const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
   const nested = await Promise.all(
      entries.map(async (entry) => {
         const target = path.join(root, entry.name);
         if (entry.isDirectory()) return listFilesRecursively(target);
         return entry.isFile() ? [target] : [];
      })
   );
   return nested.flat().sort();
}

/** Lists direct JSON children of a directory. */
async function listJsonFiles(root: string): Promise<string[]> {
   const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
   return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => path.join(root, entry.name))
      .sort();
}

/** Atomically writes JSON in the destination directory. */
async function writeJsonAtomic(file: string, value: unknown, exclusive = false): Promise<void> {
   await writeFileAtomic(
      file,
      Buffer.from(`${JSON.stringify(value, null, 2)}\n`),
      0o100600,
      exclusive
   );
}

/** Atomically replaces one file, preserving a requested mode. */
async function writeFileAtomic(
   file: string,
   bytes: Buffer,
   mode: number,
   exclusive = false
): Promise<void> {
   await fs.mkdir(path.dirname(file), { recursive: true });
   const temporary = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`
   );
   try {
      await fs.writeFile(temporary, bytes, { flag: 'wx', mode });
      await fs.chmod(temporary, mode & 0o777);
      if (exclusive && (await fileExists(file)))
         throw new Error(`Observer spool collision at ${file}.`);
      await fs.rename(temporary, file);
   } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
   }
}

/** Removes a file by first renaming it away from the live hook path. */
async function removeFileAtomically(file: string): Promise<void> {
   const tombstone = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${randomUUID()}.removed`
   );
   await fs.rename(file, tombstone);
   await fs.rm(tombstone, { force: true });
}

/** Reads JSON, treating absent and malformed files as unavailable. */
async function readJsonIfPresent(file: string): Promise<unknown | null> {
   try {
      return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
   } catch {
      return null;
   }
}

/** Reads bytes only when a file exists. */
async function readFileIfPresent(file: string): Promise<Buffer | null> {
   try {
      return await fs.readFile(file);
   } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
   }
}

/** Checks file existence without exposing filesystem errors. */
async function fileExists(file: string): Promise<boolean> {
   try {
      await fs.access(file);
      return true;
   } catch {
      return false;
   }
}

/** Reads process stdin without writing to stdout or stderr. */
async function readStdin(): Promise<Buffer> {
   const chunks: Buffer[] = [];
   for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
   }
   return Buffer.concat(chunks);
}

/** Quotes one fixed argument for the POSIX shell used by Git hooks. */
function quoteShellArgument(value: string): string {
   return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** SHA-256 helper for persisted integrity and dedupe identities. */
function hashBytes(value: Uint8Array): string {
   return createHash('sha256').update(value).digest('hex');
}

/** SHA-256 helper for canonical text. */
function hashText(value: string): string {
   return hashBytes(Buffer.from(value, 'utf8'));
}

/** Compares a parsed version against a minimum tuple. */
function compareVersion(
   version: { major: number; minor: number; patch: number },
   minimum: readonly [number, number, number]
): number {
   const values = [version.major, version.minor, version.patch];
   for (let index = 0; index < minimum.length; index++) {
      if (values[index] !== minimum[index]) return values[index] - minimum[index];
   }
   return 0;
}
