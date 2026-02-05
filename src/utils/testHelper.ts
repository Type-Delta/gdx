/* eslint-disable no-console */
import * as fs from '@/modules/fs';
import path from 'path';
import { AsyncLocalStorage } from 'async_hooks';

import { CheckCache, ncc } from '@lib/Tools';

import { GdxContext } from '@/common/types';
import { ArgsSet } from '../modules/arguments';
import { resetConfig } from '@/common/config';
import { resetCache } from '@/common/cache';
import { $, whichExec } from '@/modules/shell';
import { afterEach, beforeEach, it, mock } from 'bun:test';
import global from '../global';
import { setQuickPrintWriter } from '@/utils/utilities';
import { setLoggerSink, type LogRecord } from '@/utils/logger';

let testEnvCleared = false;
let gitExePath: string | null = null;
const stdioStore = new AsyncLocalStorage<{
   buffer: { stdout: string; stderr: string; logs: string };
}>();
let stdioHookInstalled = false;
let originalStdoutWrite: typeof process.stdout.write | null = null;
let originalStderrWrite: typeof process.stderr.write | null = null;

interface TestSystem {
   lastTestStatus: 'notrun' | 'passed' | 'failed';
   buffer?: { stdout: string; stderr: string; logs: string };
}

interface TestEnvOptions {
   autoResetBuffer?: boolean;
}

interface EnvController {
   isTTY: boolean;
}

class TestEnvTracker {
   sysClipboard: string[] = [];
   subprocessStack: string[] = [];
   spinnerStatus: 'nottriggered' | 'started' | 'stopped' = 'nottriggered';
   testSystem: TestSystem = {
      lastTestStatus: 'notrun',
   };

   reset() {
      this.sysClipboard = [];
      this.subprocessStack = [];
      this.spinnerStatus = 'nottriggered';
      this.testSystem.lastTestStatus = 'notrun';
   }
}

export function createGdxContext(tempDir: string, args: string[] = []): GdxContext {
   if (!gitExePath) {
      throw new Error('Git executable path not set. Call createTestEnv() first.');
   }

   return {
      git$: [gitExePath, '-C', tempDir],
      args: new ArgsSet(args),
   } satisfies GdxContext;
}

export async function createTestEnv(options: TestEnvOptions = { autoResetBuffer: true }) {
   console.time('createTestEnv');
   await clearTestEnvs();

   if (!gitExePath) await findGitExecutable();

   fs.mkdirSync(path.join(process.cwd(), 'test/env'), { recursive: true });
   const tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'test/env/'));
   const tmpMockProjDir = path.join(tmpDir, 'project');
   fs.mkdirSync(tmpMockProjDir, { recursive: true });
   fs.mkdirSync(path.join(tmpDir, 'tmp'), { recursive: true });

   let tracker = new TestEnvTracker();
   const envController = {
      isTTY: true,
   };

   tracker = overrideModules(tracker, tmpDir, envController);

   const _$ = $({ cwd: tmpMockProjDir });
   const cleanup = () => {
      try {
         console.log(`Cleaning up temp dir: ${tmpDir}`);
         fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
         console.error(`Failed to remove temp dir: ${tmpDir}`);
      }
   };

   // Set env vars for isolation
   process.env.GDX_CONFIG_PATH = path.join(tmpDir, '.gdx', '.gdxrc.toml');
   process.env.GDX_TEMP_DIR = tmpDir;
   process.env.GIT_CONFIG_NOSYSTEM = '1';
   global.logLevel = 'warn';

   // Create an empty global config file
   const globalConfigPath = path.join(tmpDir, '.gitconfig');
   process.env.GIT_CONFIG_GLOBAL = globalConfigPath;

   const gdxConfigPath = process.env.GDX_CONFIG_PATH;
   const gdxConfigDir = gdxConfigPath ? path.dirname(gdxConfigPath) : undefined;

   const setupTasks = [
      initGitRepo(_$), // Initialize a git repository
      fs.writeFile(globalConfigPath, ''), // Empty global git config
   ];

   if (gdxConfigDir) {
      fs.mkdirSync(gdxConfigDir, { recursive: true });
   }

   if (gdxConfigPath) {
      setupTasks.push(fs.writeFile(gdxConfigPath, '', 'utf-8'));
   }

   const [resetRepo] = await Promise.all(setupTasks as Promise<() => Promise<void>>[]);

   resetConfig();
   resetCache();

   // Disable all ANSI formatting for tests
   CheckCache.supportsColor = 0;

   const buffer = { stdout: '', stderr: '', logs: '' };
   process.env.NODE_ENV = 'test';
   ensureStdIoHooked();

   attachTestLivecycleHook(buffer, tracker, options.autoResetBuffer);
   const it = defineBunIt(tracker);
   console.timeEnd('createTestEnv');

   return {
      tmpDir: tmpMockProjDir, // Project directory
      tmpRootDir: tmpDir, // Temp root directory that contains project dir
      $: _$, // Shell function with cwd set to project dir
      buffer, // Captured stdout, stderr, and logs
      tracker, // Test environment status tracker
      cleanup, // Cleanup function to remove temp dirs
      it, // Custom it function with stdio capture
      resetRepo, // Function to reset git repo to initial state
      env: envController, // Environment controller
   };
}

async function initGitRepo(_$: typeof $) {
   await _$`${gitExePath!} init`;

   // Set user config
   await _$`${gitExePath!} config user.name ${'Test User'}`;
   await _$`${gitExePath!} config user.email ${'test@example.com'}`;

   // Create initial commit to ensure HEAD exists
   const cmiOutput = (await _$`${gitExePath!} commit --allow-empty -m ${'Initial commit'}`).stdout;
   const hash = cmiOutput.match(/^\[.* ([a-f0-9]{7,40})\]/m)?.[1];
   if (!hash) {
      throw new Error('Failed to create initial commit in test git repo.');
   }

   return async () => {
      // Reset repo to initial commit
      await _$`${gitExePath!} reset --hard ${hash}`;
   };
}

function overrideModules(
   tracker: TestEnvTracker,
   tempDir: string,
   envController: EnvController
): TestEnvTracker {
   mock.module('@/modules/shell', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const original = require('../modules/shell');
      return {
         ...original,
         copyToClipboard: async (content: string) => {
            tracker.sysClipboard.push(content);
            return true;
         },
         openInEditor: async () => {
            tracker.subprocessStack.push('openInEditor');
         },
         $prompt: async () => 'y', // Auto-confirm prompts
         spinner: () => {
            tracker.spinnerStatus = 'started';
            return {
               stop: () => {
                  tracker.spinnerStatus = 'stopped';
               },
               options: {},
            };
         },
         isTTY: () => envController.isTTY,
      };
   });

   mock.module('@/consts', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const original = require('../consts');
      const tempTmpDir = path.join(tempDir, 'tmp');
      return {
         ...original,
         TEMP_DIR: tempTmpDir,
         CURRENT_DIR: path.join(tempDir, 'project'),
         CONFIG_PATH: path.join(tempDir, '.gdx', '.gdxrc.toml'),
         CACHE_PATH: path.join(tempTmpDir, 'gdx', 'cache.json'),
         MACRO_PATH: path.join(tempDir, '.gdx', 'macro.json'),
         SHOULD_WRITE_LOGS: false,
      };
   });
   return tracker;
}

async function clearTestEnvs() {
   if (testEnvCleared) return;

   const baseTestEnvDir = path.join(process.cwd(), 'test/env');
   try {
      console.log(`Clearing all test envs in: ${baseTestEnvDir}`);
      fs.rmSync(baseTestEnvDir, { recursive: true, force: true });
      testEnvCleared = true;
   } catch {
      console.error(`Failed to clear test envs in: ${baseTestEnvDir}`);
   }
}

/**
 * Finds the git executable path and caches it.
 */
async function findGitExecutable(): Promise<string> {
   if (gitExePath) return gitExePath;

   const gitPath = await whichExec('git');
   if (!gitPath) {
      throw new Error('Git executable not found in PATH.');
   }
   gitExePath = gitPath;
   return gitExePath;
}

function defineBunIt(tracker: TestEnvTracker) {
   return function (name: string, fn: () => Promise<void> | void) {
      return it(name, async (done) => {
         await stdioStore.run(
            { buffer: tracker.testSystem.buffer ?? { stdout: '', stderr: '', logs: '' } },
            async () => {
               try {
                  await fn();
                  done();
                  tracker.testSystem.lastTestStatus = 'passed';
               } catch (error) {
                  tracker.testSystem.lastTestStatus = 'failed';
                  throw error;
               }
            }
         );
      });
   };
}

function attachTestLivecycleHook(
   buffer: { stdout: string; stderr: string; logs: string },
   tracker: TestEnvTracker,
   autoResetBuffer: boolean = true
) {
   tracker.testSystem.buffer = buffer;
   afterEach((done) => {
      if (tracker.testSystem.lastTestStatus === 'failed') {
         console.log(ncc('Dim') + '\nTest failed. Captured stdout:\n' + ncc(), buffer.stdout);
         if (buffer.stderr) console.log(ncc('Dim') + 'Captured stderr:\n' + ncc(), buffer.stderr);
      }

      done();
   });

   beforeEach(() => {
      if (autoResetBuffer) {
         buffer.stdout = '';
         buffer.stderr = '';
         buffer.logs = '';
      }
      tracker.reset();
   });
}

function ensureStdIoHooked() {
   if (stdioHookInstalled) return;
   stdioHookInstalled = true;
   originalStdoutWrite = process.stdout.write.bind(process.stdout);
   originalStderrWrite = process.stderr.write.bind(process.stderr);

   process.stdout.write = (msg: string) => {
      const store = stdioStore.getStore();
      if (store) {
         store.buffer.stdout += msg;
         return true;
      }
      return originalStdoutWrite ? originalStdoutWrite(msg) : true;
   };

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
