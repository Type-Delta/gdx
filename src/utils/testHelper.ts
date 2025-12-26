import fs from 'fs/promises';
import path from 'path';

import { GdxContext } from '@/common/types';
import { ArgsSet } from './arguments';
import { resetConfig } from '@/common/config';
import { $ } from '@/utils/shell';
import { _process } from './utilities';
import { afterEach, beforeEach, it, mock } from 'bun:test';
import { CheckCache, ncc } from '@lib/Tools';

let testEnvCleared = false;

interface TestSystem {
   lastTestStatus: 'notrun' | 'passed' | 'failed';
}

interface TestEnvOptions {
   autoResetBuffer?: boolean;
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
   return {
      git$: ['git', '-C', tempDir],
      args: new ArgsSet(args),
   } satisfies GdxContext;
}

export async function createTestEnv(options: TestEnvOptions = { autoResetBuffer: true }) {
   await clearTestEnvs();

   await fs.mkdir(path.join(process.cwd(), 'test/env'), { recursive: true });
   const tmpDir = await fs.mkdtemp(path.join(process.cwd(), 'test/env/'));
   const tmpMockProjDir = path.join(tmpDir, 'project');
   await fs.mkdir(tmpMockProjDir, { recursive: true });
   await fs.mkdir(path.join(tmpDir, 'tmp'), { recursive: true });

   let tracker = new TestEnvTracker();
   tracker = overrideModules(tracker, tmpDir);

   const _$ = $({ cwd: tmpMockProjDir });
   const cleanup = async () => {
      try {
         console.log(`Cleaning up temp dir: ${tmpDir}`);
         await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {
         console.error(`Failed to remove temp dir: ${tmpDir}`);
      }
   };

   // Initialize a git repository
   await _$`git init`;

   // Set user config
   await _$`git config user.name ${'Test User'}`;
   await _$`git config user.email ${'test@example.com'}`;

   // Create initial commit to ensure HEAD exists
   await _$`git commit --allow-empty -m ${'Initial commit'}`;

   // Set env vars for isolation
   process.env.GDX_CONFIG_PATH = path.join(tmpDir, '.gdxrc.toml');
   process.env.GDX_TEMP_DIR = tmpDir;
   process.env.GIT_CONFIG_NOSYSTEM = '1';
   // Create an empty global config file
   const globalConfigPath = path.join(tmpDir, '.gitconfig');
   await fs.writeFile(globalConfigPath, '');
   process.env.GIT_CONFIG_GLOBAL = globalConfigPath;

   resetConfig();

   // Disable all ANSI formatting for tests
   CheckCache.supportsColor = 0;

   const buffer = { stdout: '', stderr: '' };
   process.env.NODE_ENV = 'test';
   // @ts-expect-error function signature mismatch
   _process.stdout.write = (msg: string) => (buffer.stdout += msg);
   // @ts-expect-error function signature mismatch
   _process.stderr.write = (msg: string) => (buffer.stderr += msg);

   attachTestLivecycleHook(buffer, tracker, options.autoResetBuffer);
   const it = defineBunIt(tracker);

   return {
      tmpDir: tmpMockProjDir,
      tmpRootDir: tmpDir,
      $: _$,
      buffer,
      tracker,
      cleanup,
      it,
   };
}

function overrideModules(tracker: TestEnvTracker, tempDir: string): TestEnvTracker {
   mock.module('@/utils/shell', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const original = require('./shell');
      return {
         ...original,
         copyToClipboard: async (content: string) => {
            tracker.sysClipboard.push(content);
            return true;
         },
         openInEditor: async () => {
            tracker.subprocessStack.push('openInEditor called');
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
      };
   });

   mock.module('@/consts', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const original = require('../consts');
      return {
         ...original,
         TEMP_DIR: path.join(tempDir, 'tmp'),
         CURRENT_DIR: path.join(tempDir, 'project'),
         CONFIG_PATH: path.join(tempDir, '.gdxrc.toml'),
      };
   });
   return tracker;
}

async function clearTestEnvs() {
   if (testEnvCleared) return;

   const baseTestEnvDir = path.join(process.cwd(), 'test/env');
   try {
      console.log(`Clearing all test envs in: ${baseTestEnvDir}`);
      await fs.rm(baseTestEnvDir, { recursive: true, force: true });
      testEnvCleared = true;
   } catch {
      console.error(`Failed to clear test envs in: ${baseTestEnvDir}`);
   }
}

function defineBunIt(tracker: TestEnvTracker) {
   return function (name: string, fn: () => Promise<void> | void) {
      return it(name, async (done) => {
         try {
            await fn();
            done();
            tracker.testSystem.lastTestStatus = 'passed';
         } catch (error) {
            tracker.testSystem.lastTestStatus = 'failed';
            throw error;
         }
      });
   };
}

function attachTestLivecycleHook(
   buffer: { stdout: string; stderr: string },
   tracker: TestEnvTracker,
   autoResetBuffer: boolean = true
) {
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
      }
      tracker.reset();
   });
}
