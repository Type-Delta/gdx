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
});
