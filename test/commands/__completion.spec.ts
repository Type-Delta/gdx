import { afterAll, describe, expect } from 'bun:test';

import completion from '@/commands/__completion';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';
import global from '@/global';

describe('gdx __completion', async () => {
   const { tmpDir, cleanup, buffer, it } = await createTestEnv();
   afterAll(cleanup);

   it('suggests using command structure and preserves log level', async () => {
      const previous = global.logLevel;
      process.env.GDX_CMP_IDX = '2';

      const ctx = createGdxContext(tmpDir, ['__completion', 'parallel', 'fork', '--m']);
      const exitCode = await completion(ctx);

      expect(exitCode).toBe(0);
      expect(buffer.stdout).toContain('--move');
      expect(global.logLevel).toBe(previous);

      delete process.env.GDX_CMP_IDX;
   });

   it('suggests multiple root-level commands', async () => {
      process.env.GDX_CMP_IDX = '0';

      const ctx = createGdxContext(tmpDir, ['__completion', 'pa']);
      const exitCode = await completion(ctx);

      expect(exitCode).toBe(0);
      // Should suggest 'parallel' (gdx custom command)
      expect(buffer.stdout).toContain('parallel');

      delete process.env.GDX_CMP_IDX;
   });

   it('suggests git commands at root level', async () => {
      process.env.GDX_CMP_IDX = '0';

      const ctx = createGdxContext(tmpDir, ['__completion', 'st']);
      const exitCode = await completion(ctx);

      expect(exitCode).toBe(0);
      // Should suggest 'stash', 'status', 'stats'
      const output = buffer.stdout;
      expect(output).toContain('stash');
      expect(output).toContain('status');
      expect(output).toContain('stats');

      delete process.env.GDX_CMP_IDX;
   });

   it('suggests shorthands at root level', async () => {
      process.env.GDX_CMP_IDX = '0';

      const ctx = createGdxContext(tmpDir, ['__completion', 'p']);
      const exitCode = await completion(ctx);

      expect(exitCode).toBe(0);
      // Should include shorthands like 'ps', 'pl', 'pu'
      const output = buffer.stdout;
      expect(output).toContain('ps');
      expect(output).toContain('pl');

      delete process.env.GDX_CMP_IDX;
   });

   it('returns empty output for unknown command (git fallback)', async () => {
      process.env.GDX_CMP_IDX = '1';

      const ctx = createGdxContext(tmpDir, ['__completion', 'checkout', 'main']);
      const exitCode = await completion(ctx);

      expect(exitCode).toBe(0);
      // Should return no output (git fallback handled shell-side)
      expect(buffer.stdout).toBe('');

      delete process.env.GDX_CMP_IDX;
   });
});
