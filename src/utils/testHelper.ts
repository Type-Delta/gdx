/* eslint-disable no-console */
import * as fs from '@/modules/fs';
import nativeFs from 'node:fs';
import path from 'path';
import { AsyncLocalStorage } from 'async_hooks';

import { CheckCache, ncc, strWrap } from '@lib/Tools';

import { GdxContext, SpinnerOptions } from '@/common/types';
import type { LLMRequest } from '@/common/adapters/llm';
import { ArgsSet } from '../modules/arguments';
import { resetConfig } from '@/common/config';
import { resetCache } from '@/common/cache';
import {
   $,
   openInEditor,
   setInheritedExecInterceptorForTests,
   SpinnerController,
   whichExec,
} from '@/modules/shell';
import { it, mock } from 'bun:test';
import global from '../global';
import { noop, quickPrint, setQuickPrintWriter } from '@/utils/utilities';
import { setLoggerSink, type LogRecord } from '@/utils/logger';
import { stripAnsiColor } from '@/modules/graphics';
import { MockLLMAdapter } from '@/common/adapters/llm/mock';

let fallbackTestRunDir: string | null = null;
let testEnvironmentNoticeShown = false;
let gitExePath: string | null = null;
const stdioStore = new AsyncLocalStorage<{
   buffer: { stdout: string; stderr: string; logs: string };
   envState?: TestLifecycle['envState'];
}>();
let stdioHookInstalled = false;
let originalStdoutWrite: typeof process.stdout.write | null = null;
let originalStderrWrite: typeof process.stderr.write | null = null;
const USE_NATIVE_SUBMODULE_IN_TESTS = process.env.GDX_USE_INLINE_SUBMODULE === 'off';
const USE_NATIVE_GIT_CONFIG_IN_TESTS = process.env.GDX_USE_INLINE_GIT_CONFIG === 'off';
const BASE_TEST_ENV_DIR = path.resolve(import.meta.dir, '../../test/env');
const RUN_DIRECTORY_NAME = /^\d{13}(?:-\d{1,3})?$/;
const __openInEditor = openInEditor;

interface TestSystem {
   lastTestStatus: 'notrun' | 'passed' | 'failed';
   lastTestName: string;
   buffer?: { stdout: string; stderr: string; logs: string };
}

interface TestEnvOptions {
   /**
    * Automatically reset the captured stdout, stderr, and logs buffers before each test.
    * Set to false to preserve the buffers across tests, which can be useful for debugging.
    * Default is true (buffers will be reset before each test).
    */
   autoResetBuffer?: boolean;
   /**
    * If true, creates a lighter test environment by skipping git repository initialization and global git config setup.
    */
   liteMode?: boolean;
   /**
    * Optional name for the test suite, which can be used in logging or test lifecycle hooks for better identification of test runs.
    */
   suitName?: string;
   /**
    * If true, initializes the test environment with a custom test harness that captures stdout, stderr, and logs, and provides a custom 'it' function for defining tests. If false, it does not set up the test harness, allowing tests to run without interception of stdio and using the default 'it' function from the testing framework. Default is true (test harness will be initialized). Set to false if you want to manage stdio capture and test definitions manually or if you want to run a benchmark without the overhead of the test harness.
    */
   initTestHarness?: boolean;
   /**
    * Optional flags to enable/disable overwrites of certain functionalities in the test environment.
    * This allow for more granular control over which features are mocked or overridden during tests. For example, you can choose to disable the overwrite of the openInEditor function if you want to test the actual behavior of opening an editor during a test.
    */
   overwrites?: {
      openInEditor?: boolean;
   };
}

interface EnvController {
   isTTY: boolean;
}

interface TestLifecycle {
   autoResetBuffer: boolean;
   buffer: { stdout: string; stderr: string; logs: string };
   envState: {
      configPath: string;
      currentDir: string;
      gitCeilingDirectories: string;
      gitConfigGlobal: string;
      tempDir: string;
   };
   testLogDir: string;
}

interface TestLLMHooks {
   onGenerate?: (request: LLMRequest) => void;
   onStreamGenerate?: (request: LLMRequest) => void;
   generateResponse?: string;
   streamResponse?: string;
}

type GlobalWithTestHooks = typeof globalThis & {
   __GDX_TEST_LLM_HOOKS?: TestLLMHooks;
};

/**
 * Helper function to reset the git repository to its initial state.
 *
 * Reset behavior:
 * - For 'full' reset: Resets the repository to the initial commit, discarding all changes, branches, and commits made during the test. This is useful for tests that need a completely clean slate.
 * - For 'worktree' reset: Resets the working tree to the initial commit but preserves the git history (branches and commits). This is faster than a full reset and can be used for tests that only need to revert file changes without affecting the git objects.
 */
type ResetRepoFunction = (mode?: 'full' | 'worktree') => Promise<void>;

class TestEnvTracker {
   sysClipboard: string[] = [];
   subprocessStack: string[] = [];
   openedPaths: string[] = [];
   scheduledDirs: string[] = [];
   llmGenerateRequests: LLMRequest[] = [];
   llmStreamRequests: LLMRequest[] = [];
   llmMockGenerateResponse = 'Mock response from LLM';
   llmMockStreamResponse = 'Mock response from LLM';
   spinnerStatus: 'nottriggered' | 'started' | 'stopped' = 'nottriggered';
   testSystem: TestSystem = {
      lastTestStatus: 'notrun',
      lastTestName: '',
   };

   reset() {
      this.sysClipboard = [];
      this.subprocessStack = [];
      this.openedPaths = [];
      this.scheduledDirs = [];
      this.llmGenerateRequests = [];
      this.llmStreamRequests = [];
      this.llmMockGenerateResponse = 'Mock response from LLM';
      this.llmMockStreamResponse = 'Mock response from LLM';
      this.spinnerStatus = 'nottriggered';
      this.testSystem.lastTestStatus = 'notrun';
   }
}

function installTestLLMHooks(tracker: TestEnvTracker): void {
   const globalWithHooks = globalThis as GlobalWithTestHooks;
   globalWithHooks.__GDX_TEST_LLM_HOOKS = {
      onGenerate: (request: LLMRequest) => {
         tracker.llmGenerateRequests.push(request);
      },
      onStreamGenerate: (request: LLMRequest) => {
         tracker.llmStreamRequests.push(request);
      },
      get generateResponse() {
         return tracker.llmMockGenerateResponse;
      },
      get streamResponse() {
         return tracker.llmMockStreamResponse;
      },
   };
}

export function createGdxContext(tempDir: string, args: string[] = []): GdxContext {
   if (!gitExePath) {
      throw new Error('Git executable path not set. Call createTestEnv() first.');
   }

   return {
      git$: [gitExePath, '-C', tempDir],
      args: new ArgsSet(args),
      repository: {
         root: path.resolve(tempDir),
         gitDir: path.resolve(tempDir, '.git'),
         commonGitDir: path.resolve(tempDir, '.git'),
      },
   } satisfies GdxContext;
}

export async function setTestGitConfig(
   repoPath: string,
   key: string,
   value: string,
   options?: { scope?: 'local' | 'global' | 'system'; add?: boolean }
): Promise<void> {
   if (!gitExePath) {
      throw new Error('Git executable path not set. Call createTestEnv() first.');
   }

   const shouldIncludeRepo = (options?.scope || 'local') === 'local';
   const gitRef = shouldIncludeRepo ? [gitExePath, '-C', repoPath] : gitExePath;
   const { setGitConfigValue } = await import('@/modules/git');

   await setGitConfigValue(gitRef, key, value, {
      repoPath,
      scope: options?.scope || 'local',
      add: options?.add,
   });
}

export async function unsetTestGitConfig(
   repoPath: string,
   key: string,
   options?: { scope?: 'local' | 'global' | 'system'; all?: boolean }
): Promise<void> {
   if (!gitExePath) {
      throw new Error('Git executable path not set. Call createTestEnv() first.');
   }

   const shouldIncludeRepo = (options?.scope || 'local') === 'local';
   const gitRef = shouldIncludeRepo ? [gitExePath, '-C', repoPath] : gitExePath;
   const { unsetGitConfigValue } = await import('@/modules/git');

   await unsetGitConfigValue(gitRef, key, {
      repoPath,
      scope: options?.scope || 'local',
      all: options?.all,
   });
}

/**
 * Creates a temporary test environment with an initialized git repository, isolated configuration, and utilities for testing. Returns the path to the temporary directory, a shell function with the working directory set to the project directory, and a cleanup function to remove the temporary files after tests are done. The environment is automatically cleaned up before creation to ensure a fresh state for each test run. The function also sets up environment variables to isolate git configuration and provides utilities for capturing stdout, stderr, and logs during tests. Optionally, it can initialize a custom test harness that provides a custom 'it' function and captures stdio for better control over test execution and output capture.
 * @param options Configuration options for the test environment setup
 * @return An object containing the path to the temporary project directory, a shell function for executing commands within that directory, a buffer for captured output, a test environment tracker, a cleanup function to remove temporary files, and a custom 'it' function for defining tests if the test harness is initialized.
 */
export async function createTestEnv(options: TestEnvOptions = {}) {
   const resolvedOptions = {
      autoResetBuffer: options.autoResetBuffer ?? true,
      liteMode: options.liteMode ?? false,
      suitName: options.suitName,
      initTestHarness: options.initTestHarness ?? true,
      overwrites: {
         openInEditor: true,
         ...options.overwrites,
      },
   };
   printTestEnvironmentNotices();
   const testRunDir = getTestRunDir();
   fs.mkdirSync(testRunDir, { recursive: true });

   const tmpDir = fs.mkdtempSync(
      testRunDir + (resolvedOptions.suitName ? `/${resolvedOptions.suitName}-` : '/')
   );
   const tmpDirName = path.basename(tmpDir);

   console.time('createTestEnv ' + tmpDirName + (resolvedOptions.liteMode ? ' (lite)' : ''));

   if (!gitExePath) await findGitExecutable();
   const tmpMockProjDir = path.join(tmpDir, 'project');
   const testLogDir = path.join(tmpDir, '.gdx', 'logs');
   fs.mkdirSync(tmpMockProjDir, { recursive: true });
   fs.mkdirSync(path.join(tmpDir, 'tmp'), { recursive: true });
   fs.mkdirSync(testLogDir, { recursive: true });

   let tracker = new TestEnvTracker();
   const envController = {
      isTTY: true,
   };

   const _$ = $({ cwd: tmpMockProjDir });
   const cleanup = () => {
      try {
         console.time(`Cleaning up temp dir: ${tmpDir}`);
         fs.rmSync(tmpDir, { recursive: true, force: true });
         console.timeEnd(`Cleaning up temp dir: ${tmpDir}`);
      } catch {
         console.error(`Failed to remove temp dir: ${tmpDir}`);
      }
   };

   // Set env vars for isolation
   process.env.GIT_CEILING_DIRECTORIES = tmpDir; // Prevent git from searching for repos above
   process.env.GDX_CONFIG_PATH = path.join(tmpDir, '.gdx', '.gdxrc.toml');
   process.env.GDX_CURRENT_DIR = tmpMockProjDir;
   process.env.GDX_TEMP_DIR = tmpDir;
   process.env.GIT_CONFIG_NOSYSTEM = '1';
   process.env.GDX_USE_INLINE_SUBMODULE = USE_NATIVE_SUBMODULE_IN_TESTS ? 'off' : 'internal';
   global.logLevel = 'warn';

   // Create an empty global config file
   const globalConfigPath = path.join(tmpDir, '.gitconfig');
   process.env.GIT_CONFIG_GLOBAL = globalConfigPath;

   const gdxConfigPath = process.env.GDX_CONFIG_PATH;
   const gdxConfigDir = gdxConfigPath ? path.dirname(gdxConfigPath) : undefined;

   const setupTasks = [
      resolvedOptions.liteMode
         ? Promise.resolve(noop as ResetRepoFunction)
         : initGitRepo(_$, tmpMockProjDir, tmpDir), // Initialize a git repository
      resolvedOptions.liteMode
         ? Promise.resolve()
         : // Native (non-inline) submodule commands clone fixtures from local paths,
           // which git blocks by default since 2.38.1 (CVE-2022-39253).
           fs.writeFile(globalConfigPath, '[protocol "file"]\n\tallow = always\n'),
   ];

   if (gdxConfigDir) {
      fs.mkdirSync(gdxConfigDir, { recursive: true });
   }

   if (gdxConfigPath) {
      setupTasks.push(fs.writeFile(gdxConfigPath, '', 'utf-8'));
   }

   const resetRepo: ResetRepoFunction = (await Promise.all(setupTasks))[0] as ResetRepoFunction;

   resetConfig();
   resetCache();

   // Disable all ANSI formatting for tests
   CheckCache.supportsColor = 0;

   // Increase semaphore limit to speed up tests
   global.threadResources.setMax(100);

   const buffer = { stdout: '', stderr: '', logs: '' };
   process.env.NODE_ENV = 'test';
   ensureStdIoHooked();

   const shouldUseHarness =
      resolvedOptions.initTestHarness === false ||
      (options.initTestHarness === undefined && Object.keys(options).length > 0);

   let lifecycle: TestLifecycle | undefined;
   if (shouldUseHarness) {
      tracker = overrideModules(tracker, tmpDir, envController, resolvedOptions.overwrites);
      lifecycle = {
         autoResetBuffer: resolvedOptions.autoResetBuffer,
         buffer,
         envState: {
            configPath: path.join(tmpDir, '.gdx', '.gdxrc.toml'),
            currentDir: tmpMockProjDir,
            gitCeilingDirectories: tmpDir,
            gitConfigGlobal: globalConfigPath,
            tempDir: tmpDir,
         },
         testLogDir,
      };
      attachTestLivecycleHook(buffer, tracker);
   }
   const testCase = shouldUseHarness ? defineBunIt(tracker, lifecycle) : noop;
   console.timeEnd('createTestEnv ' + tmpDirName + (resolvedOptions.liteMode ? ' (lite)' : ''));

   return {
      tmpDir: tmpMockProjDir, // Project directory
      tmpRootDir: tmpDir, // Temp root directory that contains project dir
      $: _$, // Shell function with cwd set to project dir
      buffer, // Captured stdout, stderr, and logs
      tracker, // Test environment status tracker
      cleanup, // Cleanup function to remove temp dirs
      it: testCase, // Custom it function with stdio capture
      resetRepo, // Function to reset git repo to initial state
      env: envController, // Environment controller
   };
}

async function initGitRepo(
   _$: typeof $,
   repoPath: string,
   tempDir: string
): Promise<ResetRepoFunction> {
   await _$`${gitExePath!} init`;

   // Set user config
   await setTestGitConfig(repoPath, 'user.name', 'Test User');
   await setTestGitConfig(repoPath, 'user.email', 'test@example.com');

   // Create initial commit to ensure HEAD exists
   const cmiOutput = (
      await _$`${gitExePath!} commit --allow-empty --no-verify -m ${'Initial commit'}`
   ).stdout;
   const hash = cmiOutput.match(/^\[.* ([a-f0-9]{7,40})\]/m)?.[1];
   if (!hash) {
      throw new Error('Failed to create initial commit in test git repo.');
   }

   // Create .git backup dir
   const gitBakPath = path.join(tempDir, 'tmp', `.git.bak-${Date.now()}`);
   fs.cpSync(path.join(repoPath, '.git'), gitBakPath, { recursive: true });

   return async (mode = 'worktree') => {
      if (mode === 'full') {
         // Restore .git from backup to reset all git state (branches, commits, config, etc)
         fs.rmSync(path.join(repoPath, '.git'), { recursive: true, force: true });
         fs.cpSync(gitBakPath, path.join(repoPath, '.git'), { recursive: true });
      }

      // Reset repo to initial commit
      await _$`${gitExePath!} -C ${repoPath} reset --hard ${hash}`;
      await _$`${gitExePath!} -C ${repoPath} clean -fdx`;
   };
}

function overrideModules(
   tracker: TestEnvTracker,
   tempDir: string,
   envController: EnvController,
   overwrites?: TestEnvOptions['overwrites']
): TestEnvTracker {
   mock.clearAllMocks();
   mock.module('@/common/adapters/llm/index', () => ({
      getLLMProvider: () => {
         return new MockLLMAdapter({
            responseDelayMs: 1,
            streamDelayMs: 0,
         });
      },
   }));

   mock.module('@/modules/shell', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const original = require('../modules/shell');
      /** Copies completed inherited-process output into the active test buffer. */
      const appendInheritedOutput = (result: unknown): void => {
         if (!result || typeof result !== 'object') return;
         const output = result as { stdout?: unknown; stderr?: unknown };
         for (const [stream, value] of Object.entries(output)) {
            if (stream !== 'stdout' && stream !== 'stderr') continue;
            const text =
               typeof value === 'string'
                  ? value
                  : value instanceof Uint8Array
                    ? Buffer.from(value).toString()
                    : '';
            if (!text) continue;
            const store = stdioStore.getStore();
            if (store) {
               store.buffer[stream] += text;
            } else if (stream === 'stdout' && originalStdoutWrite) {
               originalStdoutWrite(text);
            } else if (stream === 'stderr' && originalStderrWrite) {
               originalStderrWrite(text);
            }
         }
      };

      /** Runs one otherwise-inherited process with stdout and stderr piped. */
      const captureInheritedExec = async (
         executeNative: (...args: unknown[]) => unknown,
         args: unknown[]
      ): Promise<unknown> => {
         const pipedExec = executeNative({ stdout: 'pipe', stderr: 'pipe' }) as (
            ...args: unknown[]
         ) => Promise<unknown>;
         try {
            const result = await pipedExec(...args);
            appendInheritedOutput(result);
            return result;
         } catch (error) {
            appendInheritedOutput(error);
            throw error;
         }
      };

      setInheritedExecInterceptorForTests(
         (executeNative: (...args: unknown[]) => unknown, args: unknown[]) =>
            stdioStore.getStore()
               ? captureInheritedExec(executeNative, args)
               : executeNative(...args)
      );
      return {
         ...original,
         copyToClipboard: async (content: string) => {
            tracker.sysClipboard.push(content);
            return true;
         },
         openInEditor: (async (targetPath: string, editorCommand?: string) => {
            tracker.subprocessStack.push('openInEditor');
            tracker.openedPaths.push(targetPath);

            if (overwrites?.openInEditor === false) {
               await __openInEditor(targetPath, editorCommand);
            }
         }) satisfies typeof openInEditor,
         $prompt: async () => 'y', // Auto-confirm prompts
         spinner: () => {
            return {
               start: () => {
                  tracker.spinnerStatus = 'started';
               },
               stop: () => {
                  tracker.spinnerStatus = 'stopped';
               },
               setMessage: () => {},
               updateProgress: () => {},
               options: {} as Required<SpinnerOptions>,
            } satisfies SpinnerController;
         },
         isTTY: () => envController.isTTY,
         scheduleChangeDir: (targetDir?: string) => {
            if (targetDir) tracker.scheduledDirs.push(targetDir);
         },
      };
   });

   mock.module('@/consts', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const original = require('../consts');
      const getRoot = () =>
         stdioStore.getStore()?.envState?.tempDir || process.env.GDX_TEMP_DIR || tempDir;
      const getTempTmpDir = () => path.join(getRoot(), 'tmp');
      return {
         ...original,
         get TEMP_DIR() {
            return getTempTmpDir();
         },
         get CURRENT_DIR() {
            return path.join(getRoot(), 'project');
         },
         get CONFIG_PATH() {
            return path.join(getRoot(), '.gdx', '.gdxrc.toml');
         },
         get CACHE_PATH() {
            return path.join(getTempTmpDir(), 'gdx', 'cache.json');
         },
         get LOG_PATH() {
            return path.join(getTempTmpDir(), 'gdx', 'gdx.log');
         },
         get MACRO_PATH() {
            return path.join(getRoot(), '.gdx', 'macro.json');
         },
         get GDX_RESULT_FILE() {
            return process.env.GDX_RESULT;
         },
         SHOULD_WRITE_LOGS: false,
         SGR: {
            reset: '',
            normal: '',
            black: '',
            white: '',
            red: '',
            green: '',
            yellow: '',
            blue: '',
            magenta: '',
            cyan: '',
            dim: '',
            italic: '',
            bright: '',
            invert: '',
            underline: '',
            bgWhite: '',
            bgRed: '',
            bgYellow: '',
         } as const satisfies Record<string, string>,
      };
   });

   return tracker;
}

/**
 * Returns an identifier shared by workers belonging to one Bun test invocation.
 * Parallel workers have the same orchestrator parent; a serial process uses its
 * own pid. The identifier is only used for the non-coordinated fallback marker.
 */
function getTestRunKey(): string {
   if (process.env.BUN_TEST_WORKER_ID) {
      return `parallel-${process.ppid}`;
   }
   return `serial-${process.pid}`;
}

/**
 * Resolves the root under which this invocation's suite environments live.
 *
 * Coordinated test wrappers provide an absolute `GDX_TEST_RUN_DIR` directly
 * below `test/env`; that value is preferred. Direct imports use an atomic marker
 * to make one unique fallback root discoverable by all Bun workers sharing the
 * invocation. Fallback roots use the same compact timestamp names as the
 * coordinated runner. The fallback deliberately leaves existing entries untouched;
 * lifecycle cleanup belongs to the wrapper (or the returned suite cleanup).
 */
function getTestRunDir(): string {
   const configuredRunDir = process.env.GDX_TEST_RUN_DIR?.trim();
   if (configuredRunDir) {
      // The wrapper supplies an absolute path. Resolving a relative value below
      // the repository anchor keeps direct, hand-written imports safe as well.
      const resolvedRunDir = path.isAbsolute(configuredRunDir)
         ? path.resolve(configuredRunDir)
         : path.resolve(BASE_TEST_ENV_DIR, configuredRunDir);
      if (!isDirectChildPath(resolvedRunDir)) {
         throw new Error(
            `GDX_TEST_RUN_DIR must resolve to a direct child of "${BASE_TEST_ENV_DIR}"; received "${configuredRunDir}".`
         );
      }
      // Do not follow a direct-child symlink out of the repository.
      if (nativeFs.existsSync(resolvedRunDir)) {
         try {
            if (!isDirectChildPath(nativeFs.realpathSync.native(resolvedRunDir))) {
               throw new Error('configured path resolves outside the test environment');
            }
         } catch {
            throw new Error(
               `GDX_TEST_RUN_DIR must resolve to a direct child of "${BASE_TEST_ENV_DIR}"; received "${configuredRunDir}".`
            );
         }
      }
      return resolvedRunDir;
   }

   if (fallbackTestRunDir) return fallbackTestRunDir;

   fs.mkdirSync(BASE_TEST_ENV_DIR, { recursive: true });

   const markerPath = path.join(BASE_TEST_ENV_DIR, `.gdx-fallback-run-${getTestRunKey()}`);
   const invalidMarker = (reason: string): never => {
      throw new Error(
         `Invalid fallback test-run marker "${markerPath}": ${reason} Remove the marker and retry.`
      );
   };
   const readMarker = (): string | undefined => {
      let markerStats: nativeFs.Stats;
      try {
         markerStats = nativeFs.lstatSync(markerPath);
      } catch (error) {
         if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return undefined;
         }
         return invalidMarker('the marker cannot be read');
      }
      if (!markerStats.isFile()) return invalidMarker('it is not a regular file');

      let candidate: string;
      try {
         candidate = nativeFs.readFileSync(markerPath, 'utf8').trim();
      } catch {
         return invalidMarker('its contents cannot be read');
      }
      if (!candidate || !path.isAbsolute(candidate)) {
         return invalidMarker('it does not contain an absolute run-root path');
      }

      const resolvedCandidate = path.resolve(candidate);
      if (
         !isDirectChildPath(resolvedCandidate) ||
         !RUN_DIRECTORY_NAME.test(path.basename(resolvedCandidate))
      ) {
         return invalidMarker(
            'its path must be a direct child named with a 13-digit epoch timestamp and optional numeric collision suffix'
         );
      }

      try {
         const targetStats = nativeFs.lstatSync(resolvedCandidate);
         if (!targetStats.isDirectory() || targetStats.isSymbolicLink()) {
            return invalidMarker('its run-root path is not a real directory');
         }
         if (!isDirectChildPath(nativeFs.realpathSync.native(resolvedCandidate))) {
            return invalidMarker('its run-root path resolves outside the test environment');
         }
      } catch (error) {
         if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
            return invalidMarker('its run-root path cannot be inspected safely');
         }
         // Cleanup can remove the target while retaining the marker. The same
         // direct child is recreated below; the marker is never replaced.
      }
      return resolvedCandidate;
   };
   const ensureRunDir = (runDir: string): string => {
      try {
         const targetStats = nativeFs.lstatSync(runDir);
         if (!targetStats.isDirectory() || targetStats.isSymbolicLink()) {
            return invalidMarker('its run-root path is not a real directory');
         }
         if (!isDirectChildPath(nativeFs.realpathSync.native(runDir))) {
            return invalidMarker('its run-root path resolves outside the test environment');
         }
      } catch (error) {
         if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
            return invalidMarker('its run-root path cannot be inspected safely');
         }
         fs.mkdirSync(runDir, { recursive: true });
      }
      try {
         const now = new Date();
         nativeFs.utimesSync(runDir, now, now);
         nativeFs.utimesSync(markerPath, now, now);
      } catch {
         return invalidMarker('its run-root path cannot be refreshed safely');
      }
      return runDir;
   };

   const existingRunDir = readMarker();
   if (existingRunDir) {
      fallbackTestRunDir = ensureRunDir(existingRunDir);
      return fallbackTestRunDir;
   }

   for (let attempt = 0; attempt < 3; attempt += 1) {
      const candidateRunDir = createFallbackRunDir();
      let claimed = false;
      try {
         // Claim only an absent marker. Replacing one after an earlier read can
         // move a fresh marker published by another worker.
         fs.writeFileSync(markerPath, `${candidateRunDir}\n`, { flag: 'wx' });
         claimed = true;
         fallbackTestRunDir = candidateRunDir;
         return candidateRunDir;
      } catch {
         // Another worker claimed the marker after our read.
      } finally {
         if (!claimed) fs.rmSync(candidateRunDir, { recursive: true, force: true });
      }

      const claimedRunDir = readMarker();
      if (claimedRunDir) {
         fallbackTestRunDir = ensureRunDir(claimedRunDir);
         return fallbackTestRunDir;
      }
   }

   throw new Error(`Unable to coordinate test run directory: ${markerPath}`);
}

function createFallbackRunDir(): string {
   const timestamp = Date.now().toString();
   for (let suffix = 0; suffix < 1_000; suffix += 1) {
      const name = suffix === 0 ? timestamp : `${timestamp}-${suffix}`;
      const candidate = path.join(BASE_TEST_ENV_DIR, name);
      try {
         fs.mkdirSync(candidate);
         return candidate;
      } catch (error) {
         if (error instanceof Error && 'code' in error && error.code === 'EEXIST') continue;
         throw error;
      }
   }
   throw new Error(`Unable to allocate fallback test run directory in: ${BASE_TEST_ENV_DIR}`);
}

function isDirectChildPath(candidatePath: string): boolean {
   const relativePath = path.relative(BASE_TEST_ENV_DIR, path.resolve(candidatePath));
   return (
      relativePath.length > 0 &&
      relativePath !== '..' &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath) &&
      !relativePath.includes(path.sep)
   );
}

function printTestEnvironmentNotices(): void {
   if (testEnvironmentNoticeShown) return;
   testEnvironmentNoticeShown = true;

   if (USE_NATIVE_SUBMODULE_IN_TESTS) {
      quickPrint(ncc('Yellow') + 'Using native git submodules in tests' + ncc());
   }

   if (USE_NATIVE_GIT_CONFIG_IN_TESTS) {
      quickPrint(ncc('Yellow') + 'Using native git config in tests' + ncc());
   }
}

/**
 * Finds the git executable path and caches it for the current test process.
 *
 * This deliberately bypasses the persistent which-cache. It runs before `createTestEnv()`
 * redirects `@/consts`, so a cached lookup here would read the developer's real global
 * cache and pin the whole suite to whatever Git a previous run — possibly from a different
 * shell, with a different PATH — happened to resolve.
 */
async function findGitExecutable(): Promise<string> {
   if (gitExePath) return gitExePath;

   const gitPath = await whichExec('git', { noCache: true });
   if (!gitPath) {
      throw new Error('Git executable not found in PATH.');
   }
   gitExePath = gitPath;
   return gitExePath;
}

function applyTestEnvState(envState: TestLifecycle['envState']): void {
   process.env.GIT_CEILING_DIRECTORIES = envState.gitCeilingDirectories;
   process.env.GDX_CONFIG_PATH = envState.configPath;
   process.env.GDX_CURRENT_DIR = envState.currentDir;
   process.env.GDX_TEMP_DIR = envState.tempDir;
   process.env.GIT_CONFIG_GLOBAL = envState.gitConfigGlobal;
   process.env.GIT_CONFIG_NOSYSTEM = '1';
   process.env.GDX_USE_INLINE_SUBMODULE = USE_NATIVE_SUBMODULE_IN_TESTS ? 'off' : 'internal';
   process.env.GDX_USE_INLINE_GIT_CONFIG = USE_NATIVE_GIT_CONFIG_IN_TESTS ? 'off' : 'internal';
}

async function writeTestDebugLog(lifecycle: TestLifecycle, testName: string): Promise<void> {
   const { buffer, testLogDir } = lifecycle;
   const logFilePath = path.join(
      testLogDir,
      `test-${testName.replaceAll(/[^a-zA-Z0-9]/g, '_')}.log`
   );
   await fs
      .writeFile(
         logFilePath,
         `STDOUT:\n${buffer.stdout}\n\nSTDERR:\n${buffer.stderr}\n\nLOGS:\n${stripAnsiColor(buffer.logs)}`,
         'utf-8'
      )
      .catch((err) => {
         console.error(`Failed to write test logs to file: ${err}`);
      });
}

/**
 * Locates a POSIX shell capable of running Git hook scripts.
 *
 * On Windows the shell ships inside Git for Windows, but `git.exe` is exposed from several
 * directories (`cmd/`, `bin/`, `mingw64/bin/`) depending on how PATH was set up, so the
 * shell cannot be derived from the Git binary with a fixed relative walk — the correct
 * number of levels to climb differs per layout. Walk upwards instead and probe the known
 * locations, verifying a candidate exists before returning it.
 *
 * @param gitExe - Path to the resolved Git executable.
 * @returns Path to a POSIX shell; plain `sh` on non-Windows platforms.
 * @throws {Error} When no shell can be found near Git or on PATH.
 */
export async function resolvePosixShell(gitExe: string): Promise<string> {
   if (process.platform !== 'win32') {
      return 'sh';
   }

   const relativeCandidates = [
      ['bin', 'sh.exe'],
      ['usr', 'bin', 'sh.exe'],
   ];

   let dir = path.dirname(gitExe);
   for (let depth = 0; depth < 4; depth++) {
      for (const relative of relativeCandidates) {
         const candidate = path.join(dir, ...relative);
         if (fs.existsSync(candidate)) {
            return candidate;
         }
      }

      const parent = path.dirname(dir);
      if (parent === dir) {
         break;
      }
      dir = parent;
   }

   const fromPath = await whichExec('sh');
   if (fromPath) {
      return fromPath;
   }

   throw new Error(
      `Unable to locate a POSIX shell near "${gitExe}" or on PATH; Git hook tests cannot run.`
   );
}

/**
 * Multiplier applied to per-test timeouts. Parallel workers (`bun test --parallel`)
 * contend for CPU and disk, so tests calibrated for serial runs need more headroom.
 */
const TEST_TIMEOUT_SCALE = process.env.BUN_TEST_WORKER_ID ? 3 : 1;

function defineBunIt(tracker: TestEnvTracker, lifecycle?: TestLifecycle) {
   return function (name: string, fn: () => Promise<void> | void, options?: { timeout?: number }) {
      options = {
         timeout: 20000, // Default timeout of 20 seconds for each test
         ...options,
      };
      options.timeout! *= TEST_TIMEOUT_SCALE;

      return it(
         name,
         async () => {
            if (lifecycle) {
               applyTestEnvState(lifecycle.envState);
               if (lifecycle.autoResetBuffer) {
                  lifecycle.buffer.stdout = '';
                  lifecycle.buffer.stderr = '';
                  lifecycle.buffer.logs = '';
               }
               tracker.reset();
               installTestLLMHooks(tracker);
            }
            await stdioStore.run(
               {
                  buffer: tracker.testSystem.buffer ?? { stdout: '', stderr: '', logs: '' },
                  envState: lifecycle?.envState,
               },
               async () => {
                  try {
                     await fn();
                     tracker.testSystem.lastTestStatus = 'passed';
                     tracker.testSystem.lastTestName = name;
                  } catch (error) {
                     tracker.testSystem.lastTestStatus = 'failed';
                     tracker.testSystem.lastTestName = name;
                     if (lifecycle) {
                        console.log(
                           ncc('Dim') + '\nTest failed. Captured stdout:\n ' + ncc(),
                           strWrap(lifecycle.buffer.stdout, 100, { indent: 2 })
                        );
                        if (lifecycle.buffer.stderr)
                           console.log(
                              ncc('Dim') + 'Captured stderr:\n ' + ncc(),
                              strWrap(lifecycle.buffer.stderr, 100, { indent: 2 })
                           );
                        if (lifecycle.buffer.logs)
                           console.log(
                              ncc('Dim') + 'Captured logs:\n ' + ncc(),
                              strWrap(lifecycle.buffer.logs, 100, { indent: 2 })
                           );
                        await writeTestDebugLog(lifecycle, name);
                     }
                     throw error;
                  }
               }
            );
            if (lifecycle) await writeTestDebugLog(lifecycle, name);
         },
         options
      );
   };
}

function attachTestLivecycleHook(
   buffer: { stdout: string; stderr: string; logs: string },
   tracker: TestEnvTracker
) {
   tracker.testSystem.buffer = buffer;
}

function ensureStdIoHooked() {
   if (stdioHookInstalled) return;
   stdioHookInstalled = true;
   originalStdoutWrite = process.stdout.write.bind(process.stdout);
   originalStderrWrite = process.stderr.write.bind(process.stderr);
   const originalStdoutIsTTY = process.stdout.isTTY;
   const originalStdinIsTTY = process.stdin.isTTY;

   process.stdout.write = (msg: string) => {
      const store = stdioStore.getStore();
      if (store) {
         store.buffer.stdout += msg;
         return true;
      }
      return originalStdoutWrite ? originalStdoutWrite(msg) : true;
   };

   Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      get() {
         return stdioStore.getStore() ? true : originalStdoutIsTTY;
      },
   });

   Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      get() {
         return stdioStore.getStore() ? true : originalStdinIsTTY;
      },
   });

   process.stderr.write = (msg: string) => {
      const store = stdioStore.getStore();
      if (store) {
         store.buffer.stderr += msg;
         return true;
      }
      return originalStderrWrite ? originalStderrWrite(msg) : true;
   };

   setQuickPrintWriter((msg) => {
      const store = stdioStore.getStore();
      if (store) {
         store.buffer.stdout += msg;
         return;
      }
      if (originalStdoutWrite) originalStdoutWrite(msg);
   });

   setLoggerSink((record: LogRecord) => {
      const store = stdioStore.getStore();
      if (!store) return;

      // Format log entry same as Logger.flushLogs()
      const paddedLevel = record.level.toUpperCase().padEnd(5);
      const logLine = `${record.timestamp} [${paddedLevel}] ${record.module}: ${record.message}\n`;
      store.buffer.logs += logLine;
   });
}
