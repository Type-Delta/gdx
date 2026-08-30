import { expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import litedent from 'litedent';

import { createTestEnv } from '@/utils/testHelper';

it('converges direct fallback workers on one run root', async () => {
   const testEnvDir = path.resolve(import.meta.dir, '../env');
   const markerPath = path.join(testEnvDir, `.gdx-fallback-run-parallel-${process.pid}`);
   const staleRunDir = path.join(testEnvDir, `${Date.now()}-1`);
   const helperPath = path.resolve(import.meta.dir, '../../src/utils/testHelper.ts');
   const barrierDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdx-test-helper-barrier-'));
   const goPath = path.join(barrierDir, 'go');
   const oldDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
   const workerCount = 24;
   const roots = new Set<string>();
   const workers: Bun.Subprocess[] = [];

   try {
      fs.writeFileSync(markerPath, `${staleRunDir}\n`);
      fs.utimesSync(markerPath, oldDate, oldDate);

      const workerCode = litedent`
         import nativeFs from 'node:fs';
         import { createTestEnv } from ${JSON.stringify(helperPath)};
         nativeFs.writeFileSync(process.env.GDX_FALLBACK_READY!, 'ready');
         while (!nativeFs.existsSync(process.env.GDX_FALLBACK_GO!)) await new Promise((resolve) => setTimeout(resolve, 1));
         const env = await createTestEnv({ liteMode: true });
         console.log('ROOT=' + env.tmpRootDir);
      `;
      const workerEnv = { ...process.env };
      delete workerEnv.GDX_TEST_RUN_DIR;
      workerEnv.BUN_TEST_WORKER_ID = 'fallback-regression';

      for (let index = 0; index < workerCount; index += 1) {
         workerEnv.GDX_FALLBACK_READY = path.join(barrierDir, `ready-${index}`);
         workerEnv.GDX_FALLBACK_GO = goPath;
         workers.push(
            Bun.spawn([process.execPath, '-e', workerCode], {
               cwd: path.resolve(import.meta.dir, '../..'),
               env: workerEnv,
               stdout: 'pipe',
               stderr: 'pipe',
            })
         );
      }

      for (let attempt = 0; attempt < 500; attempt += 1) {
         if (workers.every((_, index) => fs.existsSync(path.join(barrierDir, `ready-${index}`)))) {
            break;
         }
         await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(workers.every((_, index) => fs.existsSync(path.join(barrierDir, `ready-${index}`)))).toBe(
         true
      );
      fs.writeFileSync(goPath, 'go');

      for (const worker of workers) {
         const outputPromise =
            worker.stdout && typeof worker.stdout !== 'number'
               ? new Response(worker.stdout).text()
               : Promise.resolve('');
         const [status, output] = await Promise.all([worker.exited, outputPromise]);
         expect(status).toBe(0);
         const root = output.match(/ROOT=(.*)/)?.[1]?.trim();
         expect(root).toBeDefined();
         expect(path.basename(path.dirname(root ?? ''))).toMatch(/^\d{13}(?:-\d{1,3})?$/);
         roots.add(path.dirname(root ?? ''));
      }

      expect(roots).toHaveLength(1);
   } finally {
      for (const worker of workers) {
         worker.kill();
         await worker.exited.catch(() => undefined);
      }
      for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(staleRunDir, { recursive: true, force: true });
      fs.rmSync(markerPath, { force: true });
      fs.rmSync(barrierDir, { recursive: true, force: true });
   }
});

it('anchors test environments to the repository when cwd changes', async () => {
   const originalCwd = process.cwd();
   const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdx-test-helper-cwd-'));
   let cleanup = () => {};

   try {
      process.chdir(outsideDir);
      const env = await createTestEnv();
      cleanup = env.cleanup;

      const testEnvDir = path.resolve(import.meta.dir, '../env');
      expect(path.dirname(path.dirname(env.tmpRootDir))).toBe(testEnvDir);
      expect(path.basename(path.dirname(env.tmpRootDir))).toMatch(/^\d{13}(?:-\d{1,3})?$/);
   } finally {
      process.chdir(originalCwd);
      cleanup();
      fs.rmSync(outsideDir, { recursive: true, force: true });
   }
});

it('rejects configured run roots outside the repository test env', async () => {
   const originalRunDir = process.env.GDX_TEST_RUN_DIR;
   const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdx-test-helper-outside-'));
   const sentinel = path.join(outsideDir, 'sentinel');
   fs.writeFileSync(sentinel, 'keep me');

   try {
      process.env.GDX_TEST_RUN_DIR = outsideDir;
      await expect(createTestEnv({ liteMode: true })).rejects.toThrow(
         'GDX_TEST_RUN_DIR must resolve to a direct child'
      );
      expect(fs.existsSync(sentinel)).toBe(true);
   } finally {
      if (originalRunDir === undefined) {
         delete process.env.GDX_TEST_RUN_DIR;
      } else {
         process.env.GDX_TEST_RUN_DIR = originalRunDir;
      }
      fs.rmSync(outsideDir, { recursive: true, force: true });
   }
});

it('rejects relative configured run roots that escape the repository test env', async () => {
   const originalRunDir = process.env.GDX_TEST_RUN_DIR;

   try {
      process.env.GDX_TEST_RUN_DIR = '../../gdx-test-helper-relative-outside';
      await expect(createTestEnv({ liteMode: true })).rejects.toThrow(
         'GDX_TEST_RUN_DIR must resolve to a direct child'
      );
   } finally {
      if (originalRunDir === undefined) {
         delete process.env.GDX_TEST_RUN_DIR;
      } else {
         process.env.GDX_TEST_RUN_DIR = originalRunDir;
      }
   }
});

it('uses the coordinated run root and preserves sibling runs', async () => {
   const testEnvDir = path.resolve(import.meta.dir, '../env');
   const originalRunDir = process.env.GDX_TEST_RUN_DIR;
   const runDir = fs.mkdtempSync(path.join(testEnvDir, '.gdx-helper-explicit-'));
   const siblingRunDir = fs.mkdtempSync(path.join(testEnvDir, '.gdx-helper-sibling-'));
   const siblingSentinel = path.join(siblingRunDir, 'sentinel');
   fs.writeFileSync(siblingSentinel, 'keep me');
   let cleanup = () => {};

   try {
      process.env.GDX_TEST_RUN_DIR = runDir;
      const env = await createTestEnv({ liteMode: true, suitName: 'explicit' });
      cleanup = env.cleanup;

      expect(path.dirname(env.tmpRootDir)).toBe(runDir);
      expect(fs.existsSync(siblingSentinel)).toBe(true);
   } finally {
      cleanup();
      if (originalRunDir === undefined) {
         delete process.env.GDX_TEST_RUN_DIR;
      } else {
         process.env.GDX_TEST_RUN_DIR = originalRunDir;
      }
      fs.rmSync(runDir, { recursive: true, force: true });
      fs.rmSync(siblingRunDir, { recursive: true, force: true });
   }
});
