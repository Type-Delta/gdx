import { afterAll, describe, it, expect } from 'bun:test';
import path from 'path';

import gdxConfig from '@/commands/gdx-config';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';
import { getConfig } from '@/common/config';

describe('gdx gdx-config', async () => {
   const { tmpDir, tmpRootDir, buffer, cleanup } = await createTestEnv();
   afterAll(cleanup);

   it('should list configuration', async () => {
      const ctx = createGdxContext(tmpDir, ['gdx-config', 'list']);
      buffer.stdout = '';

      const result = await gdxConfig(ctx);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain('[llm]');
      expect(buffer.stdout).toContain('provider');
   });

   it('should show config path', async () => {
      const ctx = createGdxContext(tmpDir, ['gdx-config', 'path']);
      buffer.stdout = '';

      const result = await gdxConfig(ctx);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain(path.join(tmpRootDir, '.gdxrc.toml')); // Should contain temp dir path
   });

   it('should set a config value', async () => {
      const ctx = createGdxContext(tmpDir, ['gdx-config', 'llm.provider', 'openai']);
      buffer.stdout = '';

      const result = await gdxConfig(ctx);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain('Configuration updated');

      // Verify it persisted
      const config = await getConfig();
      // @ts-expect-error expect str literal to be asignable to undefined
      expect(config.get('llm.provider')).toBe('openai');
   });

   it('should get a config value', async () => {
      const ctx = createGdxContext(tmpDir, ['gdx-config', 'llm.provider']);
      buffer.stdout = '';

      const result = await gdxConfig(ctx);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain('openai');
   });

   it('should handle invalid keys gracefully', async () => {
      const ctx = createGdxContext(tmpDir, ['gdx-config', 'invalid.key']);
      buffer.stdout = '';

      const result = await gdxConfig(ctx);

      // Code returns 1 if key is not set
      expect(result).toBe(1);
      expect(buffer.stdout).toContain('is not set');
   });
});
