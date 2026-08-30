import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import litedent from 'litedent';

import { describe, expect, it } from 'bun:test';

import {
   acquireSemaphore,
   cleanupRunDirectories,
   createRunDirectory,
   formatTestPlatformWarning,
   reclaimResource,
   releaseSemaphore,
   runTestRunner,
   shouldUseSemaphore,
} from '../../scripts/test-runner';

const waitBriefly = (milliseconds: number) =>
   new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function temporaryRoot(): Promise<string> {
   return await mkdtemp(path.join(os.tmpdir(), 'gdx-test-runner-spec-'));
}

function quickSleep(milliseconds: number): Promise<void> {
   return waitBriefly(Math.min(milliseconds, 20));
}

async function waitForFile(filePath: string): Promise<void> {
   for (let attempt = 0; attempt < 500; attempt += 1) {
      if (
         await readFile(filePath)
            .then(() => true)
            .catch(() => false)
      )
         return;
      await waitBriefly(20);
   }
   throw new Error(`Timed out waiting for ${filePath}`);
}

async function claimCount(root: string): Promise<number> {
   const entries = await readdir(path.join(root, 'serial-intents'), { withFileTypes: true }).catch(
      () => []
   );
   return entries.filter((entry) => entry.isDirectory() && entry.name.startsWith('claim-')).length;
}

describe('coordinated test runner', () => {
   it('formats one parent-runner warning with terminal color', () => {
      expect(formatTestPlatformWarning('win32', true)).toBe(
         '\x1b[33mWarning: Process forking/spawning and I/O operations on Windows and MacOS are unbelievably slow (>10X slower); Expect tests timeout when host is busy. Close resources intensive apps before running tests.\x1b[0m'
      );
      expect(formatTestPlatformWarning('linux', true)).toBe('');
   });

   it('coordinates exactly four serial slots on supported platforms', async () => {
      const root = await temporaryRoot();
      const repoRoot = path.resolve(root, 'repo');
      const reasons: string[] = [];
      try {
         const leases = await Promise.all(
            Array.from({ length: 4 }, () =>
               acquireSemaphore(
                  'serial',
                  repoRoot,
                  { platform: 'win32', semaphoreRoot: path.join(root, 'locks'), sleep: quickSleep },
                  (reason) => reasons.push(reason)
               )
            )
         );
         expect(leases.every((lease) => lease !== undefined)).toBe(true);
         expect(await claimCount(path.join(root, 'locks'))).toBe(4);
         reasons.length = 0;
         expect(reasons).toEqual([]);

         const fifth = acquireSemaphore(
            'serial',
            repoRoot,
            { platform: 'win32', semaphoreRoot: path.join(root, 'locks'), sleep: quickSleep },
            (reason) => reasons.push(reason)
         );
         for (let attempt = 0; attempt < 100; attempt += 1) {
            if (reasons.includes('all four serial slots are busy')) break;
            await waitBriefly(20);
         }
         expect(reasons).toContain('all four serial slots are busy');
         await Promise.all(leases.map((lease) => releaseSemaphore(lease)));
         const fifthLease = await fifth;
         expect(fifthLease).toBeDefined();
         await releaseSemaphore(fifthLease);
      } finally {
         await rm(root, { recursive: true, force: true });
      }
   });

   it('keeps high-contention serial readers within the four-reader capacity', async () => {
      const root = await temporaryRoot();
      const repoRoot = path.resolve(root, 'repo');
      const semaphoreRoot = path.join(root, 'locks');
      let active = 0;
      let peak = 0;
      try {
         await Promise.all(
            Array.from({ length: 12 }, async () => {
               const lease = await acquireSemaphore('serial', repoRoot, {
                  platform: 'win32',
                  semaphoreRoot,
                  sleep: quickSleep,
               });
               active += 1;
               peak = Math.max(peak, active);
               await waitBriefly(20);
               active -= 1;
               await releaseSemaphore(lease);
            })
         );
         expect(peak).toBeLessThanOrEqual(4);
      } finally {
         await rm(root, { recursive: true, force: true });
      }
   });

   it('lets parallel runs drain serial owners and blocks new serial owners', async () => {
      const root = await temporaryRoot();
      const repoRoot = path.resolve(root, 'repo');
      const semaphoreRoot = path.join(root, 'locks');
      const reasons: string[] = [];
      try {
         const serial = await acquireSemaphore('serial', repoRoot, {
            platform: 'win32',
            semaphoreRoot,
            sleep: quickSleep,
         });
         const parallelPromise = acquireSemaphore(
            'parallel',
            repoRoot,
            { platform: 'win32', semaphoreRoot, sleep: quickSleep },
            (reason) => reasons.push(reason)
         );
         for (let attempt = 0; attempt < 100; attempt += 1) {
            if (reasons.includes('waiting for existing serial test runs to finish')) break;
            await waitBriefly(20);
         }
         expect(reasons).toContain('waiting for existing serial test runs to finish');

         const serialAfterParallel = acquireSemaphore(
            'serial',
            repoRoot,
            { platform: 'win32', semaphoreRoot, sleep: quickSleep },
            (reason) => reasons.push(reason)
         );
         for (let attempt = 0; attempt < 100; attempt += 1) {
            if (reasons.includes('parallel test run is active')) break;
            await waitBriefly(20);
         }
         expect(reasons).toContain('parallel test run is active');

         await releaseSemaphore(serial);
         const parallel = await parallelPromise;
         expect(parallel?.mode).toBe('parallel');
         await releaseSemaphore(parallel);
         const serialLease = await serialAfterParallel;
         expect(serialLease?.mode).toBe('serial');
         await releaseSemaphore(serialLease);
      } finally {
         await rm(root, { recursive: true, force: true });
      }
   });

   it('keeps an admitted serial ahead of a delayed earlier parallel intent', async () => {
      const root = await temporaryRoot();
      const repoRoot = path.resolve(root, 'repo');
      const semaphoreRoot = path.join(root, 'locks');
      const fixedTime = 1_700_000_000_000;
      const delayedPath = path.join(
         semaphoreRoot,
         'parallel-intents',
         'parallel-1700000000000-00000000-0000-4000-8000-000000000000'
      );
      const staleMetadata = {
         token: '00000000-0000-4000-8000-000000000000',
         mode: 'parallel',
         admission: 'tentative',
         supervisorPid: process.pid,
         childPid: null,
         startedAt: new Date(fixedTime).toISOString(),
         heartbeatAt: new Date().toISOString(),
      };
      const reasons: string[] = [];
      try {
         const serial = await acquireSemaphore('serial', repoRoot, {
            platform: 'win32',
            semaphoreRoot,
            now: () => fixedTime,
            sleep: quickSleep,
         });
         await mkdir(delayedPath, { recursive: true });
         await writeFile(path.join(delayedPath, 'owner.json'), JSON.stringify(staleMetadata));

         const parallelPromise = acquireSemaphore(
            'parallel',
            repoRoot,
            { platform: 'win32', semaphoreRoot, now: () => fixedTime, sleep: quickSleep },
            (reason) => reasons.push(reason)
         );
         for (let attempt = 0; attempt < 100; attempt += 1) {
            if (reasons.includes('waiting for existing serial test runs to finish')) break;
            await waitBriefly(20);
         }
         expect(reasons).toContain('waiting for existing serial test runs to finish');
         await releaseSemaphore(serial);
         await rm(delayedPath, { recursive: true, force: true });

         const parallel = await parallelPromise;
         expect(parallel?.mode).toBe('parallel');
         await releaseSemaphore(parallel);
      } finally {
         await rm(root, { recursive: true, force: true });
      }
   });

   it('reclaims a stale lease owned by a dead process', async () => {
      const root = await temporaryRoot();
      const repoRoot = path.resolve(root, 'repo');
      const semaphoreRoot = path.join(root, 'locks');
      const parallelPath = path.join(semaphoreRoot, 'parallel');
      const staleTime = new Date(Date.now() - 60_000).toISOString();
      try {
         await mkdir(parallelPath, { recursive: true });
         await writeFile(
            path.join(parallelPath, 'owner.json'),
            JSON.stringify({
               token: randomUUID(),
               mode: 'parallel',
               supervisorPid: 4_000_000,
               childPid: 4_000_001,
               startedAt: staleTime,
               heartbeatAt: staleTime,
            })
         );
         const lease = await acquireSemaphore('parallel', repoRoot, {
            platform: 'win32',
            semaphoreRoot,
            sleep: quickSleep,
         });
         expect(lease?.mode).toBe('parallel');
         await releaseSemaphore(lease);
      } finally {
         await rm(root, { recursive: true, force: true });
      }
   });

   it('reclaims an old empty tokenless resource after the Windows quarantine rename', async () => {
      const root = await temporaryRoot();
      const resourcePath = path.join(root, 'resource');
      const staleTime = new Date(Date.now() - 60_000);
      try {
         await mkdir(resourcePath);
         await utimes(resourcePath, staleTime, staleTime);

         expect(await reclaimResource(resourcePath, Date.now())).toBe(true);
         expect(await readdir(resourcePath).catch(() => undefined)).toBeUndefined();
      } finally {
         await rm(root, { recursive: true, force: true });
      }
   });

   it('reclaims a malformed tokenless resource after the Windows quarantine rename', async () => {
      const root = await temporaryRoot();
      const resourcePath = path.join(root, 'resource');
      const staleTime = new Date(Date.now() - 60_000);
      try {
         await mkdir(resourcePath);
         await writeFile(path.join(resourcePath, 'owner.json'), '{malformed');
         await utimes(resourcePath, staleTime, staleTime);

         expect(await reclaimResource(resourcePath, Date.now())).toBe(true);
         expect(await readdir(resourcePath).catch(() => undefined)).toBeUndefined();
      } finally {
         await rm(root, { recursive: true, force: true });
      }
   });

   it('reclaims abandoned unique queue intents after a runner crash', async () => {
      const root = await temporaryRoot();
      const semaphoreRoot = path.join(root, 'locks');
      const staleTime = new Date(Date.now() - 60_000).toISOString();
      const staleToken = randomUUID();
      const stalePath = path.join(
         semaphoreRoot,
         'serial-intents',
         `claim-0000000000000-${staleToken}`
      );
      try {
         await mkdir(stalePath, { recursive: true });
         await writeFile(
            path.join(stalePath, 'owner.json'),
            JSON.stringify({
               token: staleToken,
               mode: 'serial',
               supervisorPid: 4_000_000,
               childPid: 4_000_001,
               startedAt: staleTime,
               heartbeatAt: staleTime,
            })
         );
         await utimes(stalePath, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

         const lease = await acquireSemaphore('serial', path.join(root, 'repo'), {
            platform: 'win32',
            semaphoreRoot,
            sleep: quickSleep,
         });
         expect(lease).toBeDefined();
         expect(await readdir(stalePath).catch(() => undefined)).toBeUndefined();
         await releaseSemaphore(lease);
      } finally {
         await rm(root, { recursive: true, force: true });
      }
   });

   it('recovers a queue intent left by a killed subprocess', async () => {
      const root = await temporaryRoot();
      const repoRoot = path.join(root, 'repo');
      const semaphoreRoot = path.join(root, 'locks');
      const markerPath = path.join(root, 'owner-path');
      const runnerPath = path.resolve(import.meta.dir, '../../scripts/test-runner.ts');
      const childCode = litedent`
         const { acquireSemaphore } = await import(${JSON.stringify(runnerPath)});
         const lease = await acquireSemaphore('serial', ${JSON.stringify(repoRoot)}, { platform: 'win32', semaphoreRoot: ${JSON.stringify(semaphoreRoot)} });
         await Bun.write(${JSON.stringify(markerPath)}, lease.ownerPath);
         await new Promise(() => {});
      `;
      await mkdir(repoRoot, { recursive: true });
      const child = Bun.spawn([process.execPath, '-e', childCode], {
         cwd: repoRoot,
         stdout: 'pipe',
         stderr: 'pipe',
      });
      try {
         await waitForFile(markerPath);
         const ownerPath = await readFile(markerPath, 'utf8');
         child.kill('SIGKILL');
         await child.exited;
         const metadataPath = path.join(ownerPath, 'owner.json');
         const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<
            string,
            unknown
         >;
         const staleTime = new Date(Date.now() - 60_000).toISOString();
         await writeFile(
            metadataPath,
            JSON.stringify({
               ...metadata,
               supervisorPid: 4_000_000,
               childPid: 4_000_001,
               heartbeatAt: staleTime,
               startedAt: staleTime,
            })
         );

         const lease = await acquireSemaphore('serial', repoRoot, {
            platform: 'win32',
            semaphoreRoot,
            sleep: quickSleep,
         });
         expect(lease).toBeDefined();
         await releaseSemaphore(lease);
      } finally {
         child.kill('SIGKILL');
         await child.exited.catch(() => undefined);
         await rm(root, { recursive: true, force: true });
      }
   });

   it('preserves a replacement generation when a stale reaper has an old token', async () => {
      const root = await temporaryRoot();
      const resourcePath = path.join(root, 'resource');
      const oldToken = randomUUID();
      const replacementToken = randomUUID();
      const staleTime = new Date(Date.now() - 60_000).toISOString();
      try {
         await mkdir(resourcePath, { recursive: true });
         await writeFile(
            path.join(resourcePath, 'owner.json'),
            JSON.stringify({
               token: replacementToken,
               mode: 'parallel',
               supervisorPid: 4_000_000,
               childPid: 4_000_001,
               startedAt: staleTime,
               heartbeatAt: staleTime,
            })
         );

         expect(await reclaimResource(resourcePath, Date.now(), oldToken)).toBe(false);
         expect(await readFile(path.join(resourcePath, 'owner.json'), 'utf8')).toContain(
            replacementToken
         );
      } finally {
         await rm(root, { recursive: true, force: true });
      }
   });

   it('reports waits immediately and forwards the child environment and exit code', async () => {
      const root = await temporaryRoot();
      const repoRoot = path.resolve(root, 'repo');
      const envRoot = path.join(root, 'env');
      const semaphoreRoot = path.join(root, 'locks');
      const output: string[] = [];
      const originalWrite = process.stderr.write;
      const write = ((chunk: string | Uint8Array) => {
         output.push(String(chunk));
         return true;
      }) as typeof process.stderr.write;
      let held: Awaited<ReturnType<typeof acquireSemaphore>>[] = [];
      let child: Promise<number> | undefined;
      try {
         await mkdir(repoRoot, { recursive: true });
         held = await Promise.all(
            Array.from({ length: 4 }, () =>
               acquireSemaphore('serial', repoRoot, {
                  platform: 'win32',
                  semaphoreRoot,
                  sleep: quickSleep,
               })
            )
         );
         process.stderr.write = write;
         child = runTestRunner(
            'serial',
            ['bun', '-e', 'if (!process.env.GDX_TEST_RUN_DIR) process.exit(17); process.exit(7)'],
            { repoRoot, envRoot, semaphoreRoot, platform: 'win32', sleep: quickSleep }
         );
         for (let attempt = 0; attempt < 50; attempt += 1) {
            if (
               output
                  .join('')
                  .includes('Waiting for test runner slot: all four serial slots are busy')
            ) {
               break;
            }
            await waitBriefly(20);
         }
         expect(output.join('')).toContain(
            'Waiting for test runner slot: all four serial slots are busy'
         );
         await Promise.all(held.map((lease) => releaseSemaphore(lease)));
         expect(await child).toBe(7);
         const artifactLine = output.find((line) => line.includes('Test run artifacts:'));
         expect(artifactLine).toBeDefined();
         const artifactPath = artifactLine?.split('Test run artifacts: ')[1]?.trim();
         expect(artifactPath).toBeDefined();
         expect(
            await readFile(path.join(artifactPath ?? '', '.gdx-test-run.json'), 'utf8')
         ).toContain('startedAt');
      } finally {
         await Promise.all(held.map((lease) => releaseSemaphore(lease)));
         if (child) await child.catch(() => 1);
         process.stderr.write = originalWrite;
         await rm(root, { recursive: true, force: true });
      }
   });

   it('terminates the child and forwards an external abort as SIGTERM status', async () => {
      const root = await temporaryRoot();
      const controller = new AbortController();
      const run = runTestRunner('serial', [process.execPath, '-e', 'setTimeout(() => {}, 10000)'], {
         platform: 'linux',
         repoRoot: root,
         envRoot: path.join(root, 'env'),
         signal: controller.signal,
      });
      try {
         await waitBriefly(200);
         controller.abort();
         expect(await run).toBe(143);
      } finally {
         await run.catch(() => 1);
         await rm(root, { recursive: true, force: true });
      }
   });

   for (const [signalName, expectedExitCode] of [
      ['SIGINT', 130],
      ['SIGTERM', 143],
   ] as const) {
      it(`prints artifacts after a real ${signalName}`, async () => {
         const root = await temporaryRoot();
         const repoRoot = path.join(root, 'repo');
         const envRoot = path.join(root, 'env');
         const semaphoreRoot = path.join(root, 'locks');
         const readyPath = path.join(root, 'ready');
         const runnerPath = path.resolve(import.meta.dir, '../../scripts/test-runner.ts');
         const childCode =
            "Bun.write(process.env.GDX_TEST_SIGNAL_READY!, 'ready'); setTimeout(() => {}, 10000)";
         const runnerCode = litedent`
            import { runTestRunner } from ${JSON.stringify(runnerPath)};
            process.exitCode = await runTestRunner('serial', [${JSON.stringify(process.execPath)}, '-e', ${JSON.stringify(childCode)}], { repoRoot: ${JSON.stringify(repoRoot)}, envRoot: ${JSON.stringify(envRoot)}, semaphoreRoot: ${JSON.stringify(semaphoreRoot)} });
         `;
         await mkdir(repoRoot, { recursive: true });
         const wrapper = Bun.spawn([process.execPath, '-e', runnerCode], {
            cwd: repoRoot,
            env: { ...process.env, GDX_TEST_SIGNAL_READY: readyPath },
            stdout: 'pipe',
            stderr: 'pipe',
         });
         const stderrPromise = wrapper.stderr
            ? new Response(wrapper.stderr).text()
            : Promise.resolve('');
         try {
            await waitForFile(readyPath);
            wrapper.kill(signalName);
            expect(await wrapper.exited).toBe(expectedExitCode);
            const stderr = await stderrPromise;
            expect(stderr).toContain('Test run artifacts:');
         } finally {
            wrapper.kill('SIGKILL');
            await wrapper.exited.catch(() => undefined);
            await rm(root, { recursive: true, force: true });
         }
      });
   }

   it('bypasses the semaphore on Linux', () => {
      expect(shouldUseSemaphore('linux')).toBe(false);
      expect(shouldUseSemaphore('darwin')).toBe(true);
      expect(shouldUseSemaphore('win32')).toBe(true);
   });

   it('creates timestamped roots and removes only owned artifacts older than one day', async () => {
      const root = await temporaryRoot();
      const envRoot = path.join(root, 'test', 'env');
      const stale = path.join(envRoot, '1577836800000');
      const fresh = path.join(envRoot, '1577836800000-1');
      const legacyStale = path.join(envRoot, 'old-suite-Ab12cd');
      const staleFallbackMarker = path.join(envRoot, '.gdx-fallback-run-serial-old');
      const freshFallbackMarker = path.join(envRoot, '.gdx-fallback-run-serial-fresh');
      const unrelated = path.join(envRoot, 'keep-this-directory');
      try {
         await mkdir(stale, { recursive: true });
         await mkdir(fresh, { recursive: true });
         await mkdir(legacyStale, { recursive: true });
         await writeFile(staleFallbackMarker, 'old run');
         await writeFile(freshFallbackMarker, 'current run');
         await mkdir(unrelated, { recursive: true });
         const oldDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
         await utimes(stale, oldDate, oldDate);
         await utimes(legacyStale, oldDate, oldDate);
         await utimes(staleFallbackMarker, oldDate, oldDate);
         await utimes(unrelated, oldDate, oldDate);
         const runRoot = await createRunDirectory(envRoot);
         await cleanupRunDirectories(envRoot, Date.now(), runRoot);
         expect(path.dirname(runRoot)).toBe(envRoot);
         expect(path.basename(runRoot)).toMatch(/^\d{13}(?:-\d+)?$/);
         expect(await readdir(stale).catch(() => undefined)).toBeUndefined();
         expect(await readdir(legacyStale).catch(() => undefined)).toBeUndefined();
         expect(await readFile(staleFallbackMarker).catch(() => undefined)).toBeUndefined();
         expect(
            await readdir(fresh)
               .then(() => true)
               .catch(() => false)
         ).toBe(true);
         expect(
            await readFile(freshFallbackMarker)
               .then(() => true)
               .catch(() => false)
         ).toBe(true);
         expect(
            await readdir(unrelated)
               .then(() => true)
               .catch(() => false)
         ).toBe(true);
         expect(
            await readdir(runRoot)
               .then(() => true)
               .catch(() => false)
         ).toBe(true);
      } finally {
         await rm(root, { recursive: true, force: true });
      }
   });

   it('adds a short numeric suffix only when a timestamp root collides', async () => {
      const root = await temporaryRoot();
      const envRoot = path.join(root, 'test', 'env');
      const timestamp = 1_700_000_000_000;
      try {
         const first = await createRunDirectory(envRoot, timestamp);
         const second = await createRunDirectory(envRoot, timestamp);
         expect(path.basename(first)).toBe('1700000000000');
         expect(path.basename(second)).toBe('1700000000000-1');
      } finally {
         await rm(root, { recursive: true, force: true });
      }
   });
});
