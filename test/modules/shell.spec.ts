import { afterEach, describe, expect, it } from 'bun:test';

import globalState from '@/global';
import { $, $inherit, createAbortableExec, redrawText } from '@/modules/shell';
import { Semaphore } from '@/utils/operation';

const originalThreadResources = globalState.threadResources;
const originalStdoutColumnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
const originalStdoutWrite = process.stdout.write;

describe('shell', () => {
   afterEach(() => {
      globalState.threadResources = originalThreadResources;
      process.stdout.write = originalStdoutWrite;

      if (originalStdoutColumnsDescriptor) {
         Object.defineProperty(process.stdout, 'columns', originalStdoutColumnsDescriptor);
      } else {
         Reflect.deleteProperty(process.stdout, 'columns');
      }
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

   it('should account for terminal word wrapping when redrawing text', () => {
      const output: string[] = [];

      Object.defineProperty(process.stdout, 'columns', { value: 10, configurable: true });
      process.stdout.write = ((chunk: string | Uint8Array) => {
         output.push(String(chunk));
         return true;
      }) as typeof process.stdout.write;

      redrawText('12345678901\n123456789012345678901', 'done');

      expect(output[0]).toBe('\x1b[5F');
   });

   it('should measure terminal redraw rows by display width', () => {
      const output: string[] = [];

      Object.defineProperty(process.stdout, 'columns', { value: 10, configurable: true });
      process.stdout.write = ((chunk: string | Uint8Array) => {
         output.push(String(chunk));
         return true;
      }) as typeof process.stdout.write;

      redrawText(`\x1b[31m12345678901\x1b[39m`, 'done', { redundancyLv: 0 });

      expect(output[0]).toBe('\x1b[2F');
   });

   it('should allow redraw display-width redundancy to be configured', () => {
      const output: string[] = [];

      Object.defineProperty(process.stdout, 'columns', { value: 10, configurable: true });
      process.stdout.write = ((chunk: string | Uint8Array) => {
         output.push(String(chunk));
         return true;
      }) as typeof process.stdout.write;

      redrawText(`\x1b[31m12345678901\x1b[39m`, 'done', { redundancyLv: -1 });

      expect(output[0]).toBe('\x1b[3F');
   });

   it('should support inline redraws without appending a newline', () => {
      const output: string[] = [];

      Object.defineProperty(process.stdout, 'columns', { value: 10, configurable: true });
      process.stdout.write = ((chunk: string | Uint8Array) => {
         output.push(String(chunk));
         return true;
      }) as typeof process.stdout.write;

      redrawText('old', 'new', { end: '', inline: true });

      expect(output.join('')).toBe('\r\x1b[2Knew');
   });
});
