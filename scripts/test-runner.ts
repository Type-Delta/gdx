import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** The two coordinated test-runner modes. */
export type TestRunnerMode = 'serial' | 'parallel';

/** Metadata written into each semaphore owner directory. */
export interface OwnerMetadata {
   token: string;
   mode: TestRunnerMode;
   admission: 'tentative' | 'active';
   supervisorPid: number;
   childPid: number | null;
   startedAt: string;
   heartbeatAt: string;
}

/** A claimed semaphore resource. */
export interface SemaphoreLease {
   mode: TestRunnerMode;
   token: string;
   ownerPath: string;
   metadataPath: string;
   childPid: number | null;
   stopHeartbeat: () => void;
}

interface RunnerOptions {
   repoRoot?: string;
   envRoot?: string;
   semaphoreRoot?: string;
   platform?: NodeJS.Platform;
   now?: () => number;
   sleep?: (milliseconds: number) => Promise<void>;
   signal?: AbortSignal;
}

interface CreatedOwner {
   token: string;
   ownerPath: string;
   metadataPath: string;
}

interface Intent {
   path: string;
   order: string;
   mode: TestRunnerMode;
   metadata?: OwnerMetadata;
}

const SERIAL_SLOT_COUNT = 4;
const SEMAPHORE_DIRECTORY_PREFIX = 'gdx-test-semaphore-';
const RUN_RETENTION_MS = 24 * 60 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 1_000;
const HEARTBEAT_STALE_MS = 10_000;
const WAIT_MESSAGE_INTERVAL_MS = 1_500;
const LEASE_WAIT_MS = 100;
const INTENT_PENDING_PREFIX = '.pending-';
const SERIAL_CLAIM_PREFIX = 'claim-';
const PARALLEL_INTENT_PREFIX = 'parallel-';
const TEST_PLATFORM_WARNING =
   'Warning: Process forking/spawning and I/O operations on Windows and MacOS are unbelievably slow (>10X slower); Expect tests timeout when host is busy. Close resources intensive apps before running tests.';
let lastIntentTimestamp = 0;

const defaultSleep = (milliseconds: number) =>
   new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

class RunnerAbortedError extends Error {
   constructor() {
      super('Test runner interrupted.');
      this.name = 'RunnerAbortedError';
   }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
   if (signal?.aborted) throw new RunnerAbortedError();
}

function isNodeError(error: unknown, code: string): boolean {
   return error instanceof Error && 'code' in error && error.code === code;
}

function canonicalPath(value: string): string {
   const resolved = path.resolve(value);
   try {
      return fs.realpathSync.native(resolved).replaceAll('\\', '/');
   } catch {
      return resolved.replaceAll('\\', '/');
   }
}

/** Returns whether this platform should coordinate test invocations. */
export function shouldUseSemaphore(platform: NodeJS.Platform = process.platform): boolean {
   return platform === 'darwin' || platform === 'win32';
}

/** Returns whether runner diagnostics should contain ANSI color. */
function shouldUseColor(): boolean {
   if (process.env.FORCE_COLOR !== undefined) return process.env.FORCE_COLOR !== '0';
   if (process.env.NO_COLOR !== undefined) return false;
   return Boolean(process.stderr.isTTY);
}

/** Formats the one-per-run platform performance warning. */
export function formatTestPlatformWarning(
   platform: NodeJS.Platform = process.platform,
   color = shouldUseColor()
): string {
   if (!shouldUseSemaphore(platform)) return '';
   return color ? `\x1b[33m${TEST_PLATFORM_WARNING}\x1b[0m` : TEST_PLATFORM_WARNING;
}

/** Prints the platform performance warning from the parent runner process. */
export function printTestPlatformWarning(platform: NodeJS.Platform = process.platform): void {
   const warning = formatTestPlatformWarning(platform);
   if (warning) process.stderr.write(`${warning}\n`);
}

/** Returns the OS-temporary semaphore directory for a canonical repository. */
export function getSemaphoreRoot(repoRoot: string, temporaryRoot: string = os.tmpdir()): string {
   const canonical = canonicalPath(repoRoot);
   const key = createHash('sha256')
      .update(process.platform === 'win32' ? canonical.toLowerCase() : canonical)
      .digest('hex')
      .slice(0, 32);
   return path.join(temporaryRoot, `${SEMAPHORE_DIRECTORY_PREFIX}${key}`);
}

function createMetadata(mode: OwnerMetadata['mode'], token = randomUUID()): OwnerMetadata {
   const timestamp = new Date().toISOString();
   return {
      token,
      mode,
      admission: 'tentative',
      supervisorPid: process.pid,
      childPid: null,
      startedAt: timestamp,
      heartbeatAt: timestamp,
   };
}

async function readMetadata(metadataPath: string): Promise<OwnerMetadata | undefined> {
   try {
      const text = await readFile(metadataPath, 'utf8');
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object') return undefined;
      const value = parsed as Partial<OwnerMetadata>;
      if (
         typeof value.token !== 'string' ||
         typeof value.supervisorPid !== 'number' ||
         typeof value.heartbeatAt !== 'string'
      ) {
         return undefined;
      }
      return {
         token: value.token,
         mode: value.mode === 'parallel' ? 'parallel' : 'serial',
         admission: value.admission === 'tentative' ? 'tentative' : 'active',
         supervisorPid: value.supervisorPid,
         childPid: typeof value.childPid === 'number' ? value.childPid : null,
         startedAt: typeof value.startedAt === 'string' ? value.startedAt : value.heartbeatAt,
         heartbeatAt: value.heartbeatAt,
      };
   } catch {
      return undefined;
   }
}

async function writeMetadata(metadataPath: string, metadata: OwnerMetadata): Promise<void> {
   const temporaryPath = `${metadataPath}.${metadata.token}.tmp`;
   await writeFile(temporaryPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
   try {
      await rename(temporaryPath, metadataPath);
   } catch (error) {
      // Windows does not replace an existing file with rename(). Guard the
      // replacement with the token that owns the metadata file.
      if (!isNodeError(error, 'EEXIST') && !isNodeError(error, 'EPERM')) throw error;
      const current = await readMetadata(metadataPath);
      if (current && current.token !== metadata.token) {
         await rm(temporaryPath, { force: true });
         return;
      }
      await rm(metadataPath, { force: true });
      await rename(temporaryPath, metadataPath);
   }
}

function pidIsAlive(pid: number | null | undefined): boolean {
   if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
   try {
      process.kill(pid, 0);
      return true;
   } catch (error) {
      // EPERM means the process exists but is not inspectable. EINVAL is
      // returned by some Windows runtimes for a live process as well.
      return isNodeError(error, 'EPERM') || isNodeError(error, 'EINVAL');
   }
}

function metadataIsFresh(metadata: OwnerMetadata, now: number): boolean {
   const heartbeat = Date.parse(metadata.heartbeatAt);
   return Number.isFinite(heartbeat) && now - heartbeat < HEARTBEAT_STALE_MS;
}

function ownerIsAlive(metadata: OwnerMetadata): boolean {
   return pidIsAlive(metadata.supervisorPid) || pidIsAlive(metadata.childPid);
}

function metadataIsReclaimable(
   metadata: OwnerMetadata | undefined,
   mtimeMs: number,
   now: number
): boolean {
   if (!metadata) return now - mtimeMs >= HEARTBEAT_STALE_MS;
   return !ownerIsAlive(metadata) && !metadataIsFresh(metadata, now);
}

async function inspectIntent(
   intentPath: string,
   mode?: TestRunnerMode
): Promise<Intent | undefined> {
   try {
      await stat(intentPath);
      const name = path.basename(intentPath);
      const order = name.startsWith(SERIAL_CLAIM_PREFIX)
         ? name.slice(SERIAL_CLAIM_PREFIX.length)
         : name.startsWith(PARALLEL_INTENT_PREFIX)
           ? name.slice(PARALLEL_INTENT_PREFIX.length)
           : '';
      if (!order) return undefined;
      const intentMode = mode ?? (name.startsWith(SERIAL_CLAIM_PREFIX) ? 'serial' : 'parallel');
      return {
         path: intentPath,
         order,
         mode: intentMode,
         metadata: await readMetadata(path.join(intentPath, 'owner.json')),
      };
   } catch {
      return undefined;
   }
}

async function removeIntentIfStale(intent: Intent, now: number): Promise<boolean> {
   let details;
   try {
      details = await stat(intent.path);
   } catch {
      return true;
   }
   if (!metadataIsReclaimable(intent.metadata, details.mtimeMs, now)) return false;
   await rm(intent.path, { recursive: true, force: true });
   return true;
}

/** Reclaims a stale, never-reused intent path after checking its owner token. */
export async function reclaimResource(
   resourcePath: string,
   now: number,
   expectedToken?: string
): Promise<boolean> {
   const intent = await inspectIntent(resourcePath);
   if (!intent) {
      let details;
      try {
         details = await stat(resourcePath);
      } catch {
         return false;
      }
      const metadata = await readMetadata(path.join(resourcePath, 'owner.json'));
      if (expectedToken !== undefined && metadata?.token !== expectedToken) return false;
      if (!metadataIsReclaimable(metadata, details.mtimeMs, now)) return false;
      await rm(resourcePath, { recursive: true, force: true });
      return true;
   }
   if (expectedToken !== undefined && intent.metadata?.token !== expectedToken) return false;
   return removeIntentIfStale(intent, now);
}

async function updateHeartbeat(lease: SemaphoreLease, childPid: number | null): Promise<void> {
   const metadata = await readMetadata(lease.metadataPath);
   if (!metadata || metadata.token !== lease.token) return;
   metadata.childPid = childPid;
   metadata.heartbeatAt = new Date().toISOString();
   await writeMetadata(lease.metadataPath, metadata);
}

function startHeartbeat(lease: SemaphoreLease): void {
   const timer = setInterval(() => {
      void updateHeartbeat(lease, lease.childPid).catch(() => undefined);
   }, HEARTBEAT_INTERVAL_MS);
   timer.unref?.();
   lease.stopHeartbeat = () => clearInterval(timer);
}

async function createIntent(
   semaphoreRoot: string,
   mode: TestRunnerMode,
   timestamp: number
): Promise<CreatedOwner> {
   const token = randomUUID();
   const intentTimestamp = Math.max(0, Math.trunc(timestamp));
   lastIntentTimestamp = Math.max(lastIntentTimestamp + 1, intentTimestamp);
   const order = `${lastIntentTimestamp.toString().padStart(13, '0')}-${token}`;
   const laneRoot = path.join(
      semaphoreRoot,
      mode === 'serial' ? 'serial-intents' : 'parallel-intents'
   );
   await mkdir(laneRoot, { recursive: true });
   const prefix = mode === 'serial' ? SERIAL_CLAIM_PREFIX : PARALLEL_INTENT_PREFIX;
   const temporaryPath = path.join(laneRoot, `${INTENT_PENDING_PREFIX}${token}`);
   const ownerPath = path.join(laneRoot, `${prefix}${order}`);
   const metadataPath = path.join(temporaryPath, 'owner.json');
   try {
      await mkdir(temporaryPath);
      await writeMetadata(metadataPath, createMetadata(mode, token));
      await rename(temporaryPath, ownerPath);
      return { token, ownerPath, metadataPath: path.join(ownerPath, 'owner.json') };
   } catch (error) {
      await rm(temporaryPath, { recursive: true, force: true });
      throw error;
   }
}

async function ensureIntentRoots(semaphoreRoot: string): Promise<void> {
   await Promise.all([
      mkdir(path.join(semaphoreRoot, 'serial-intents'), { recursive: true }),
      mkdir(path.join(semaphoreRoot, 'parallel-intents'), { recursive: true }),
   ]);
}

async function listIntents(semaphoreRoot: string, now: number): Promise<Intent[]> {
   const laneRoots: Array<{ mode: TestRunnerMode; path: string }> = [
      { mode: 'serial', path: path.join(semaphoreRoot, 'serial-intents') },
      { mode: 'parallel', path: path.join(semaphoreRoot, 'parallel-intents') },
   ];
   const intents: Intent[] = [];
   await Promise.all(
      laneRoots.map(async ({ mode, path: laneRoot }) => {
         const entries = await readdir(laneRoot, { withFileTypes: true }).catch(() => []);
         await Promise.all(
            entries.map(async (entry) => {
               if (!entry.isDirectory()) return;
               const candidate = path.join(laneRoot, entry.name);
               if (entry.name.startsWith(INTENT_PENDING_PREFIX)) {
                  const details = await stat(candidate).catch(() => undefined);
                  if (details && now - details.mtimeMs >= HEARTBEAT_STALE_MS) {
                     await rm(candidate, { recursive: true, force: true });
                  }
                  return;
               }
               if (
                  !entry.name.startsWith(SERIAL_CLAIM_PREFIX) &&
                  !entry.name.startsWith(PARALLEL_INTENT_PREFIX)
               )
                  return;
               const intent = await inspectIntent(candidate, mode);
               if (!intent) return;
               if (await removeIntentIfStale(intent, now)) return;
               intents.push(intent);
            })
         );
      })
   );
   return intents.sort((left, right) =>
      left.order < right.order ? -1 : left.order > right.order ? 1 : 0
   );
}

function intentMode(intent: Intent): TestRunnerMode {
   return intent.mode;
}

async function createLease(owner: CreatedOwner, mode: TestRunnerMode): Promise<SemaphoreLease> {
   const lease: SemaphoreLease = {
      mode,
      token: owner.token,
      ownerPath: owner.ownerPath,
      metadataPath: owner.metadataPath,
      childPid: null,
      stopHeartbeat: () => undefined,
   };
   startHeartbeat(lease);
   return lease;
}

async function activateIntent(owner: CreatedOwner): Promise<void> {
   const metadata = await readMetadata(owner.metadataPath);
   if (!metadata || metadata.token !== owner.token) {
      throw new Error('Test runner intent metadata changed before admission.');
   }
   metadata.admission = 'active';
   await writeMetadata(owner.metadataPath, metadata);
}

function intentIsActive(intent: Intent): boolean {
   return intent.metadata?.admission !== 'tentative';
}

function canAdmitIntent(mode: TestRunnerMode, ownIndex: number, intents: Intent[]): boolean {
   const active = intents.filter(intentIsActive);
   if (mode === 'parallel' && active.length > 0) return false;
   if (active.some((intent) => intentMode(intent) !== mode)) return false;
   if (
      mode === 'serial' &&
      active.filter((intent) => intentMode(intent) === 'serial').length >= SERIAL_SLOT_COUNT
   ) {
      return false;
   }
   const earliestTentative = intents.findIndex((intent) => !intentIsActive(intent));
   return ownIndex === earliestTentative;
}

async function acquireIntent(
   mode: TestRunnerMode,
   semaphoreRoot: string,
   now: () => number,
   sleep: (milliseconds: number) => Promise<void>,
   reportWait: (reason: string) => void,
   signal?: AbortSignal
): Promise<SemaphoreLease> {
   const owner = await createIntent(semaphoreRoot, mode, now());
   let leased = false;
   try {
      // Let contenders finish publishing their complete intents before taking
      // the first queue snapshot. This closes the common same-turn race where
      // an early publisher would otherwise observe only itself.
      await sleep(LEASE_WAIT_MS);
      for (;;) {
         throwIfAborted(signal);
         const intents = await listIntents(semaphoreRoot, now());
         const ownIndex = intents.findIndex((intent) => intent.path === owner.ownerPath);
         if (ownIndex < 0) throw new Error('Test runner intent was unexpectedly removed.');
         if (canAdmitIntent(mode, ownIndex, intents)) {
            const stableIntents = await listIntents(semaphoreRoot, now());
            const stableIndex = stableIntents.findIndex(
               (intent) => intent.path === owner.ownerPath
            );
            if (stableIndex >= 0 && canAdmitIntent(mode, stableIndex, stableIntents)) {
               await activateIntent(owner);
               leased = true;
               return await createLease(owner, mode);
            }
         }
         const activeConflict = intents.some(
            (intent) => intentIsActive(intent) && intentMode(intent) !== mode
         );
         const earlier = intents.slice(0, ownIndex);
         const earlierParallel = earlier.some((intent) => intentMode(intent) === 'parallel');
         const earlierSerial = earlier.some((intent) => intentMode(intent) === 'serial');
         reportWait(
            mode === 'serial'
               ? activeConflict || earlierParallel
                  ? 'parallel test run is active'
                  : 'all four serial slots are busy'
               : activeConflict || earlierSerial
                 ? 'waiting for existing serial test runs to finish'
                 : 'another parallel test run is active'
         );
         throwIfAborted(signal);
         await sleep(LEASE_WAIT_MS);
      }
   } finally {
      if (!leased) await rm(owner.ownerPath, { recursive: true, force: true });
   }
}

/** Acquires the platform semaphore, or returns a no-op lease on Linux. */
export async function acquireSemaphore(
   mode: TestRunnerMode,
   repoRoot: string,
   options: Pick<RunnerOptions, 'semaphoreRoot' | 'platform' | 'now' | 'sleep' | 'signal'> = {},
   reportWait: (reason: string) => void = () => undefined
): Promise<SemaphoreLease | undefined> {
   const platform = options.platform ?? process.platform;
   if (!shouldUseSemaphore(platform)) return undefined;
   const semaphoreRoot = options.semaphoreRoot ?? getSemaphoreRoot(repoRoot);
   const now = options.now ?? Date.now;
   const sleep = options.sleep ?? defaultSleep;
   throwIfAborted(options.signal);
   await mkdir(semaphoreRoot, { recursive: true });
   await ensureIntentRoots(semaphoreRoot);
   return acquireIntent(mode, semaphoreRoot, now, sleep, reportWait, options.signal);
}

/** Releases a lease only when its UUID still owns the resource. */
export async function releaseSemaphore(lease: SemaphoreLease | undefined): Promise<void> {
   if (!lease) return;
   lease.stopHeartbeat();
   const metadata = await readMetadata(lease.metadataPath);
   if (metadata?.token !== lease.token) return;
   await rm(lease.ownerPath, { recursive: true, force: true });
}

function timestampDirectoryName(now: number, suffix?: number): string {
   const timestamp = Math.max(0, Math.trunc(now)).toString().padStart(13, '0');
   const name = suffix === undefined ? timestamp : `${timestamp}-${suffix}`;
   if (!isTimestampRunDirectoryName(name)) throw new Error(`Invalid run directory name: ${name}`);
   return name;
}

function isTimestampRunDirectoryName(name: string): boolean {
   return /^\d{13}(?:-\d+)?$/.test(name);
}

function isOwnedTestArtifact(name: string, isDirectory: boolean): boolean {
   return (
      isTimestampRunDirectoryName(name) ||
      name.startsWith('gdx-test-run-') ||
      name.startsWith('.gdx-test-run-') ||
      name.startsWith('.gdx-fallback-') ||
      (isDirectory && (/^[A-Za-z0-9]{6}$/.test(name) || /-[A-Za-z0-9]{6}$/.test(name)))
   );
}

/** Removes old test artifacts directly beneath the test environment root. */
export async function cleanupRunDirectories(
   envRoot: string,
   now = Date.now(),
   keepPath?: string
): Promise<void> {
   await mkdir(envRoot, { recursive: true });
   let entries;
   try {
      entries = await readdir(envRoot, { withFileTypes: true });
   } catch {
      return;
   }
   const threshold = now - RUN_RETENTION_MS;
   const keep = keepPath ? path.resolve(keepPath) : undefined;
   await Promise.all(
      entries
         .filter((entry) => isOwnedTestArtifact(entry.name, entry.isDirectory()))
         .map(async (entry) => {
            const candidate = path.resolve(envRoot, entry.name);
            if (candidate === keep) return;
            try {
               const details = await stat(candidate);
               if (details.mtimeMs < threshold) {
                  await rm(candidate, { recursive: true, force: true });
               }
            } catch {
               // A concurrent runner may have removed this root already.
            }
         })
   );
}

/** Creates a unique artifact root directly below the repository test/env. */
export async function createRunDirectory(envRoot: string, now = Date.now()): Promise<string> {
   await mkdir(envRoot, { recursive: true });
   for (let suffix = 0; ; suffix += 1) {
      const runPath = path.join(
         envRoot,
         timestampDirectoryName(now, suffix === 0 ? undefined : suffix)
      );
      try {
         await mkdir(runPath);
         return path.resolve(runPath);
      } catch (error) {
         if (!isNodeError(error, 'EEXIST')) throw error;
      }
   }
}

class WaitReporter {
   private lastReason = '';
   private lastPrintedAt = 0;

   report(reason: string): void {
      const timestamp = Date.now();
      if (
         reason !== this.lastReason ||
         timestamp - this.lastPrintedAt >= WAIT_MESSAGE_INTERVAL_MS
      ) {
         process.stderr.write(`Waiting for test runner slot: ${reason}\n`);
         this.lastReason = reason;
         this.lastPrintedAt = timestamp;
      }
   }
}

function commandIsBun(command: string): boolean {
   const basename = path.basename(command).toLowerCase();
   return (
      basename === 'bun' ||
      basename === 'bun.exe' ||
      path.resolve(command) === path.resolve(process.execPath)
   );
}

function childCommand(commandArgs: string[]): string[] {
   if (commandArgs.length === 0) return [process.execPath, '--no-orphans', 'test'];
   const command = commandArgs[0];
   const args = commandArgs.slice(1);
   if (commandIsBun(command) && !args.includes('--no-orphans')) {
      return [command, '--no-orphans', ...args];
   }
   return [command, ...args];
}

/** Runs a child test command under the selected coordination mode. */
export async function runTestRunner(
   mode: TestRunnerMode,
   commandArgs: string[],
   options: RunnerOptions = {}
): Promise<number> {
   const repoRoot = path.resolve(options.repoRoot ?? path.resolve(import.meta.dir, '..'));
   const envRoot = path.resolve(options.envRoot ?? path.join(repoRoot, 'test', 'env'));
   const now = options.now ?? Date.now;
   const reporter = new WaitReporter();
   let runRoot: string | undefined;
   const reportArtifacts = () => {
      if (!runRoot) return;
      process.stderr.write(`Test run artifacts: ${runRoot}\n`);
   };
   let child: Bun.Subprocess | undefined;
   let signal: NodeJS.Signals | undefined;
   const signalHandlers = new Map<NodeJS.Signals, () => void>();
   const abortController = new AbortController();
   const externalAbort = () => {
      abortController.abort();
      child?.kill('SIGTERM');
   };
   options.signal?.addEventListener('abort', externalAbort, { once: true });
   if (options.signal?.aborted) abortController.abort();
   const signalNumber = (value: NodeJS.Signals): number =>
      (os.constants.signals as Record<string, number>)[value] ?? 1;
   for (const name of ['SIGINT', 'SIGTERM'] as const) {
      const handler = () => {
         signal ??= name;
         reportArtifacts();
         abortController.abort();
         child?.kill(name);
      };
      signalHandlers.set(name, handler);
      process.on(name, handler);
   }
   let lease: SemaphoreLease | undefined;
   try {
      runRoot = await createRunDirectory(envRoot, now());
      reportArtifacts();
      await cleanupRunDirectories(envRoot, now(), runRoot);
      const runMarker = path.join(runRoot, '.gdx-test-run.json');
      await writeFile(
         runMarker,
         `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
         { mode: 0o600 }
      );
      const childEnv: NodeJS.ProcessEnv = {
         ...process.env,
         GDX_TEST_RUN_DIR: runRoot,
      };
      throwIfAborted(abortController.signal);
      lease = await acquireSemaphore(
         mode,
         repoRoot,
         { ...options, signal: abortController.signal },
         (reason) => reporter.report(reason)
      );
      child = Bun.spawn(childCommand(commandArgs), {
         cwd: repoRoot,
         env: childEnv,
         stdio: ['inherit', 'inherit', 'inherit'],
      });
      if (lease) {
         const childPid = child.pid;
         lease.childPid = childPid;
         const metadata = await readMetadata(lease.metadataPath);
         if (metadata && metadata.token === lease.token) {
            metadata.childPid = childPid;
            metadata.heartbeatAt = new Date().toISOString();
            await writeMetadata(lease.metadataPath, metadata);
         }
      }
      const childExitCode = await child.exited;
      if (signal) {
         return 128 + signalNumber(signal);
      }
      return childExitCode;
   } catch (error) {
      if (signal) return 128 + signalNumber(signal);
      process.stderr.write(
         `Test runner failed: ${error instanceof Error ? error.message : String(error)}\n`
      );
      return 1;
   } finally {
      const removeSignalHandler = process as unknown as {
         off: (event: string, listener: () => void) => void;
      };
      for (const [name, handler] of signalHandlers) removeSignalHandler.off(name, handler);
      options.signal?.removeEventListener('abort', externalAbort);
      try {
         await releaseSemaphore(lease);
      } finally {
         reportArtifacts();
      }
   }
}

function parseArguments(args: string[]): { mode: TestRunnerMode; commandArgs: string[] } {
   const mode = args.shift();
   if (mode !== 'serial' && mode !== 'parallel') {
      throw new Error('Usage: bun scripts/test-runner.ts <serial|parallel> [command ...args]');
   }
   if (args[0] === '--') args.shift();
   return { mode, commandArgs: args };
}

if (import.meta.main) {
   try {
      const { mode, commandArgs } = parseArguments(process.argv.slice(2));
      printTestPlatformWarning();
      const exitCode = await runTestRunner(mode, commandArgs);
      process.exitCode = exitCode;
   } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
   }
}
