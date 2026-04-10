import { describe, expect } from 'bun:test';

import { createTestEnv, createGdxContext } from '@/utils/testHelper';
import macro from '@/commands/macro';
import { readMacrosFromFile } from '@/modules/macro';
import * as fs from '@/modules/fs';
import path from 'path';

describe('gdx macro', async () => {
   const { tmpDir, tmpRootDir, buffer, it } = await createTestEnv({ suitName: 'macro' });

   it('should set a macro', async () => {
      const ctx = createGdxContext(tmpDir, ['macro', 'set', 'qc', 'ad .', ';', 'cmi -m "$1"']);

      const result = await macro(ctx);
      expect(result).toBe(0);
      expect(buffer.stdout).toContain("Macro 'qc' created.");

      const macros = await readMacrosFromFile();
      expect(macros['qc']).toBe('ad . ; cmi -m "$1"');
   });

   it('should overwrite an existing macro', async () => {
      const ctx1 = createGdxContext(tmpDir, ['macro', 'set', 'test', 'ad .']);
      await macro(ctx1);

      buffer.stdout = '';

      const ctx2 = createGdxContext(tmpDir, ['macro', 'set', 'test', 'status']);
      const result = await macro(ctx2);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain("Macro 'test' updated.");

      const macros = await readMacrosFromFile();
      expect(macros['test']).toBe('status');
   });

   it('should list macros', async () => {
      // Set up multiple macros
      const ctx1 = createGdxContext(tmpDir, ['macro', 'set', 'foo', 'status']);
      await macro(ctx1);

      const ctx2 = createGdxContext(tmpDir, ['macro', 'set', 'bar', 'ad . ; cmi -m "test"']);
      await macro(ctx2);

      buffer.stdout = '';

      const ctx3 = createGdxContext(tmpDir, ['macro', 'list']);
      const result = await macro(ctx3);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain('Macros:');
      expect(buffer.stdout).toContain('foo');
      expect(buffer.stdout).toContain('bar');
      expect(buffer.stdout).toContain('status');
      expect(buffer.stdout).toContain('ad . ; cmi -m "test"');
   });

   it('should show preview in list for long macros', async () => {
      const longMacro = 'a'.repeat(100);
      const ctx1 = createGdxContext(tmpDir, ['macro', 'set', 'long', longMacro]);
      await macro(ctx1);

      buffer.stdout = '';

      const ctx2 = createGdxContext(tmpDir, ['macro', 'list']);
      await macro(ctx2);

      expect(buffer.stdout).toContain('...');
      expect(buffer.stdout).not.toContain(longMacro);
   });

   it('should drop a macro', async () => {
      const ctx1 = createGdxContext(tmpDir, ['macro', 'set', 'temp', 'status']);
      await macro(ctx1);

      buffer.stdout = '';

      const ctx2 = createGdxContext(tmpDir, ['macro', 'drop', 'temp']);
      const result = await macro(ctx2);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain("Macro 'temp' deleted.");

      const macros = await readMacrosFromFile();
      expect(macros['temp']).toBeUndefined();
   });

   it('should error when dropping non-existent macro', async () => {
      const ctx = createGdxContext(tmpDir, ['macro', 'drop', 'nonexistent']);
      const result = await macro(ctx);

      expect(result).toBe(1);
      expect(buffer.logs).toContain("Macro 'nonexistent' not found.");
   });

   it('should sync macros to cache', async () => {
      const ctx1 = createGdxContext(tmpDir, ['macro', 'set', 'sync-test', 'status']);
      await macro(ctx1);

      buffer.stdout = '';

      const ctx2 = createGdxContext(tmpDir, ['macro', 'sync']);
      const result = await macro(ctx2);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain('Macros synced to cache.');
   });

   it('should error on unknown subcommand', async () => {
      const ctx = createGdxContext(tmpDir, ['macro', 'unknown']);
      const result = await macro(ctx);

      expect(result).toBe(1);
      expect(buffer.logs).toContain('Unknown macro subcommand');
   });

   it('should error when setting macro without name', async () => {
      const ctx = createGdxContext(tmpDir, ['macro', 'set']);
      const result = await macro(ctx);

      expect(result).toBe(1);
      expect(buffer.logs).toContain('Macro name is required');
   });

   it('should error when setting macro without script', async () => {
      const ctx = createGdxContext(tmpDir, ['macro', 'set', 'name']);
      const result = await macro(ctx);

      expect(result).toBe(1);
      expect(buffer.logs).toContain('Macro script or file path is required');
   });

   it('should load macro from file path', async () => {
      const scriptPath = path.join(tmpRootDir, 'macro-script.txt');
      await fs.writeFile(scriptPath, 'status -s', 'utf-8');

      const ctx = createGdxContext(tmpDir, [
         'macro',
         'set',
         'from-file',
         `./${path.basename(scriptPath)}`,
      ]);

      // Change working directory context for the test
      const originalCwd = process.cwd();
      process.chdir(tmpRootDir);

      const result = await macro(ctx);

      process.chdir(originalCwd);

      expect(result).toBe(0);

      const macros = await readMacrosFromFile();
      expect(macros['from-file']).toBe('status -s');
   });

   it('should error when file path does not exist', async () => {
      const ctx = createGdxContext(tmpDir, ['macro', 'set', 'bad', './nonexistent.txt']);

      const originalCwd = process.cwd();
      process.chdir(tmpRootDir);

      const result = await macro(ctx);

      process.chdir(originalCwd);

      expect(result).toBe(1);
      expect(buffer.logs).toContain('File not found');
   });

   it('should load macro from stdin redirection', async () => {
      const scriptContent = 'ad . ; cmi -m "from stdin"';

      // Mock stdin
      const originalIsTTY = process.stdin.isTTY;
      const originalOn = process.stdin.on;
      const originalSetEncoding = process.stdin.setEncoding;

      // Make stdin appear as non-TTY (piped)
      Object.defineProperty(process.stdin, 'isTTY', {
         value: false,
         configurable: true,
      });

      // Mock stdin methods
      let dataHandler: ((chunk: string) => void) | null = null;
      let endHandler: (() => void) | null = null;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      process.stdin.setEncoding = () => process.stdin as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      process.stdin.on = ((event: string, handler: any) => {
         if (event === 'data') {
            dataHandler = handler;
         } else if (event === 'end') {
            endHandler = handler;
         }
         return process.stdin;
         // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any;

      const ctx = createGdxContext(tmpDir, ['macro', 'set', 'from-stdin']);

      // Start the macro set operation
      const resultPromise = macro(ctx);

      // Simulate stdin data
      setTimeout(() => {
         if (dataHandler) dataHandler(scriptContent);
         if (endHandler) endHandler();
      }, 10);

      const result = await resultPromise;

      // Restore stdin
      Object.defineProperty(process.stdin, 'isTTY', {
         value: originalIsTTY,
         configurable: true,
      });
      process.stdin.on = originalOn;
      process.stdin.setEncoding = originalSetEncoding;

      expect(result).toBe(0);

      const macros = await readMacrosFromFile();
      expect(macros['from-stdin']).toBe(scriptContent);
   });
});

describe('gdx macro storage', async () => {
   const { tmpDir, it } = await createTestEnv({ suitName: 'macro-storage' });

   it('should store macro with placeholder substitution pattern', async () => {
      const ctx = createGdxContext(tmpDir, ['macro', 'set', 'qc', 'ad . ; cmi -m "$1"']);
      const result = await macro(ctx);

      expect(result).toBe(0);

      const macros = await readMacrosFromFile();
      expect(macros['qc']).toBe('ad . ; cmi -m "$1"');
   });

   it('should handle multiple commands in sequence', async () => {
      const ctx = createGdxContext(tmpDir, [
         'macro',
         'set',
         'multi',
         'ad . ; cmi -m "first" ; status',
      ]);
      const result = await macro(ctx);

      expect(result).toBe(0);

      const macros = await readMacrosFromFile();
      expect(macros['multi']).toBe('ad . ; cmi -m "first" ; status');
   });

   it('should handle macro with shorthand patterns', async () => {
      const ctx = createGdxContext(tmpDir, ['macro', 'set', 'short', 'ad . ; cmi -m "msg"']);
      const result = await macro(ctx);

      expect(result).toBe(0);

      const macros = await readMacrosFromFile();
      expect(macros['short']).toContain('ad .');
      expect(macros['short']).toContain('cmi');
   });

   it('should preserve quoted strings in macros', async () => {
      const ctx = createGdxContext(tmpDir, [
         'macro',
         'set',
         'quoted',
         'cmi -m "test message with spaces"',
      ]);
      const result = await macro(ctx);

      expect(result).toBe(0);

      const macros = await readMacrosFromFile();
      expect(macros['quoted']).toBe('cmi -m "test message with spaces"');
   });
});

describe('gdx macro custom command execution', async () => {
   const { tmpDir, buffer, it } = await createTestEnv({ suitName: 'macro-custom' });

   it('should route gdx commands through dispatch', async () => {
      // Create a macro that calls a gdx custom command
      const ctx1 = createGdxContext(tmpDir, ['macro', 'set', 'testcmd', 'clear']);
      await macro(ctx1);

      buffer.stdout = '';

      // Execute the macro - it should route through dispatch to cmd.clear
      const ctx2 = createGdxContext(tmpDir, ['testcmd']);
      const { dispatch } = await import('@/cli/dispatch');
      const result = await dispatch(ctx2);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain('Executing macro');
      // The 'clear' command should have executed
      expect(buffer.stdout).toContain('No changes to clear');
   });

   it('should execute git commands from macro', async () => {
      // Create a macro with a git command
      const ctx1 = createGdxContext(tmpDir, ['macro', 'set', 'gitstatus', 'status']);
      await macro(ctx1);

      buffer.stdout = '';

      // Execute the macro
      const ctx2 = createGdxContext(tmpDir, ['gitstatus']);
      const { dispatch } = await import('@/cli/dispatch');
      const result = await dispatch(ctx2);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain('Executing macro');
   });

   it('should execute shorthand commands from macro', async () => {
      // Create a macro with a shorthand
      const ctx1 = createGdxContext(tmpDir, ['macro', 'set', 'shortcmd', 's']);
      await macro(ctx1);

      buffer.stdout = '';

      // Execute the macro - 's' should expand to 'status'
      const ctx2 = createGdxContext(tmpDir, ['shortcmd']);
      const { dispatch } = await import('@/cli/dispatch');
      const result = await dispatch(ctx2);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain('Executing macro');
   });
});

describe('gdx macro recursion prevention', async () => {
   const { tmpDir, buffer, it } = await createTestEnv({ suitName: 'macro-recursion' });

   it('should prevent macro-in-macro invocation', async () => {
      // Create two macros: a calls b
      const ctx1 = createGdxContext(tmpDir, ['macro', 'set', 'inner', 'status']);
      await macro(ctx1);

      const ctx2 = createGdxContext(tmpDir, ['macro', 'set', 'outer', 'inner']);
      await macro(ctx2);

      buffer.stdout = '';
      buffer.logs = '';

      // Try to execute outer macro (which tries to call inner macro)
      const ctx3 = createGdxContext(tmpDir, ['outer']);
      const { dispatch } = await import('@/cli/dispatch');
      const result = await dispatch(ctx3);

      expect(result).toBe(1);
      expect(buffer.logs).toContain('cannot be invoked from inside a macro');
   });

   it('should prevent self-referencing macro', async () => {
      // Create a macro that calls itself
      const ctx1 = createGdxContext(tmpDir, ['macro', 'set', 'loop', 'loop']);
      await macro(ctx1);

      buffer.stdout = '';
      buffer.logs = '';

      // Try to execute the macro
      const ctx2 = createGdxContext(tmpDir, ['loop']);
      const { dispatch } = await import('@/cli/dispatch');
      const result = await dispatch(ctx2);

      expect(result).toBe(1);
      expect(buffer.logs).toContain('cannot be invoked from inside a macro');
   });

   it('should allow macro with regular commands', async () => {
      // Create a normal macro
      const ctx1 = createGdxContext(tmpDir, ['macro', 'set', 'normal', 'status']);
      await macro(ctx1);

      buffer.stdout = '';

      // Execute it - should work fine
      const ctx2 = createGdxContext(tmpDir, ['normal']);
      const { dispatch } = await import('@/cli/dispatch');
      const result = await dispatch(ctx2);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain('Executing macro');
   });
});
