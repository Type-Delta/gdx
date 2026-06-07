import { describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Threaded from '@/modules/threaded';
import { getGenericWorkerUrl } from '@/cli/worker'

declare const asyncDouble: (value: number) => Promise<number>;
declare const sharedMath: {
   add(a: number, b: number): number;
};
declare const statefulCounter: {
   count: number;
   next(): number;
};
declare const pathModule: typeof import('node:path');
declare const dedentModule: typeof import('dedent');

describe('Threaded', () => {
   const workerSource = getGenericWorkerUrl()!;
   expect(workerSource, 'Worker source to be defined').toBeDefined();

   it('should run async spawn tasks with required functions', async () => {
      const pool = new Threaded({ maxWorker: 2, taskTimeout: 5000, workerSource }).require(
         async (value: number) => value * 2,
         'asyncDouble'
      );

      const result = await pool.spawn((value) => asyncDouble(value), [21]);

      expect(result).toBe(42);
   });

   it('should run map tasks from data() and preserve result order', async () => {
      const pool = new Threaded({ maxWorker: 2, taskTimeout: 5000, workerSource }).require(
         { add: (a: number, b: number) => a + b },
         'sharedMath'
      );

      const result = await pool.data([1, 2, 3, 4]).map((value, index) => {
         return sharedMath.add(value, index);
      });

      expect(result).toEqual([1, 3, 5, 7]);
   });

   it('should expose required import paths to worker tasks', async () => {
      const pool = new Threaded({ maxWorker: 1, taskTimeout: 5000, workerSource }).require(
         'node:path',
         'pathModule'
      );

      const result = await pool.spawn((filePath) => pathModule.basename(filePath), [
         'src/modules/threaded.ts',
      ]);

      expect(result).toBe('threaded.ts');
   });

   it('should set worker environment before initializing tasks', async () => {
      const pool = new Threaded({
         env: { GDX_THREADED_TEST_VALUE: 'enabled' },
         maxWorker: 1,
         taskTimeout: 5000,
         workerSource,
      });

      const result = await pool.spawn(() => process.env.GDX_THREADED_TEST_VALUE);

      expect(result).toBe('enabled');
   });

   it('should run tasks through a file URL worker source', async () => {
      const pool = new Threaded({
         maxWorker: 1,
         taskTimeout: 5000,
         workerSource: new URL('../../src/workers/generic.worker.ts', import.meta.url),
      }).require('node:path', 'pathModule');

      const result = await pool.spawn((filePath) => pathModule.extname(filePath), [
         'src/modules/threaded.ts',
      ]);

      expect(result).toBe('.ts');
      await pool.destroy();
   });

   it('should resolve package imports before passing them to workers', async () => {
      const originalCwd = process.cwd();
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gdx-threaded-'));
      const pool = new Threaded({ maxWorker: 1, taskTimeout: 5000, workerSource }).require(
         'dedent',
         'dedentModule'
      );

      process.chdir(tempDir);
      try {
         const result = await pool.spawn(() => dedentModule.default`
            alpha
               beta
         `);

         expect(result).toBe('alpha\n   beta');
      } finally {
         process.chdir(originalCwd);
         await pool.destroy();
         await fs.rm(tempDir, { recursive: true, force: true });
      }
   });

   it('should reuse workers with already initialized requirements', async () => {
      const counter = {
         count: 0,
         next(this: { count: number }) {
            this.count++;
            return this.count;
         },
      };
      const pool = new Threaded({ maxWorker: 1, taskTimeout: 5000, workerSource }).require(
         counter,
         'statefulCounter'
      );

      const first = await pool.spawn(() => statefulCounter.next());
      const second = await pool.spawn(() => statefulCounter.next());

      expect([first, second]).toEqual([1, 2]);
      await pool.destroy();
   });

   it('should run map tasks with data passed directly', async () => {
      const pool = new Threaded({ maxWorker: 2, taskTimeout: 5000, workerSource });

      const result = await pool.map(async (value: number) => value * value, [2, 3, 4]);

      expect(result).toEqual([4, 9, 16]);
   });

   it('should limit workers across concurrent spawn calls', async () => {
      const pool = new Threaded({ maxWorker: 2, taskTimeout: 5000, workerSource });
      const startedAt = Date.now();

      await Promise.all([
         pool.spawn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 120));
            return 1;
         }),
         pool.spawn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 120));
            return 2;
         }),
         pool.spawn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 120));
            return 3;
         }),
      ]);

      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(220);
   });

   it('should reject tasks that exceed taskTimeout', async () => {
      const pool = new Threaded({ maxWorker: 1, taskTimeout: 50, workerSource });

      await expect(
         pool.spawn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 500));
            return 'done';
         })
      ).rejects.toThrow('timed out');
   });
});
