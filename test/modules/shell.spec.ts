import { afterEach, describe, expect, it } from 'bun:test';

import globalState from '@/global';
import { $, $inherit, createAbortableExec } from '@/modules/shell';
import { Semaphore } from '@/utils/operation';

const originalThreadResources = globalState.threadResources;

describe('shell', () => {
   afterEach(() => {
      globalState.threadResources = originalThreadResources;
   });

   it('should limit concurrent execa subprocesses globally', async () => {
      globalState.threadResources = new Semaphore(1);

      const abortable = createAbortableExec();
      const script = 'await Bun.sleep(120)';
      const start = performance.now();

      await Promise.all([
         $`${process.execPath} -e ${script}`,
         $inherit`${process.execPath} -e ${script}`,
         abortable.$`${process.execPath} -e ${script}`,
      ]);

      expect(performance.now() - start).toBeGreaterThan(300);
   });

   it('should preserve option chaining for configured execa methods', async () => {
      globalState.threadResources = new Semaphore(1);

      const configured$ = $({ cwd: process.cwd() });
      const { stdout } =
         await configured$`${process.execPath} -e ${'console.log(process.cwd())'}`;

      expect(stdout.trim()).toBe(process.cwd());
   });
});
