import { describe, expect, it } from 'bun:test';

import Threaded from '@/modules/threaded';

declare const asyncDouble: (value: number) => Promise<number>;
declare const sharedMath: {
   add(a: number, b: number): number;
};
declare const statefulCounter: {
   count: number;
   next(): number;
};
declare const pathModule: typeof import('node:path');

describe('Threaded', () => {
   it('should run async spawn tasks with required functions', async () => {
      const pool = new Threaded({ maxWorker: 2, taskTimeout: 5000 }).require(
         async (value: number) => value * 2,
         'asyncDouble'
      );

      const result = await pool.spawn((value) => asyncDouble(value), [21]);

      expect(result).toBe(42);
   });

   it('should run map tasks from data() and preserve result order', async () => {
      const pool = new Threaded({ maxWorker: 2, taskTimeout: 5000 }).require(
         { add: (a: number, b: number) => a + b },
         'sharedMath'
      );

      const result = await pool.data([1, 2, 3, 4]).map((value, index) => {
         return sharedMath.add(value, index);
      });

      expect(result).toEqual([1, 3, 5, 7]);
   });

   it('should expose required import paths to worker tasks', async () => {
      const pool = new Threaded({ maxWorker: 1, taskTimeout: 5000 }).require(
         'node:path',
         'pathModule'
      );

      const result = await pool.spawn((filePath) => pathModule.basename(filePath), [
         'src/modules/threaded.ts',
      ]);

      expect(result).toBe('threaded.ts');
   });

   it('should reuse workers with already initialized requirements', async () => {
      const counter = {
         count: 0,
         next(this: { count: number }) {
            this.count++;
            return this.count;
         },
      };
      const pool = new Threaded({ maxWorker: 1, taskTimeout: 5000 }).require(
         counter,
         'statefulCounter'
      );

      const first = await pool.spawn(() => statefulCounter.next());
      const second = await pool.spawn(() => statefulCounter.next());

      expect([first, second]).toEqual([1, 2]);
      await pool.destroy();
   });

   it('should run map tasks with data passed directly', async () => {
      const pool = new Threaded({ maxWorker: 2, taskTimeout: 5000 });

      const result = await pool.map(async (value: number) => value * value, [2, 3, 4]);

      expect(result).toEqual([4, 9, 16]);
   });

   it('should limit workers across concurrent spawn calls', async () => {
      const pool = new Threaded({ maxWorker: 2, taskTimeout: 5000 });
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
      const pool = new Threaded({ maxWorker: 1, taskTimeout: 50 });

      await expect(
         pool.spawn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 500));
            return 'done';
         })
      ).rejects.toThrow('timed out');
   });
});
