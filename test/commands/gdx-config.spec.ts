import { describe, expect } from 'bun:test';
import path from 'path';

import gdxConfig from '@/commands/gdx-config';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';
import { getConfig } from '@/common/config';

describe('gdx gdx-config', async () => {
   const { tmpDir, tmpRootDir, buffer, it } = await createTestEnv({
      liteMode: true,
      suitName: 'gdx-config'
   });

   it('should list configuration', async () => {
      const ctx = createGdxContext(tmpDir, ['gdx-config', 'list']);
      const result = await gdxConfig(ctx);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain('[llm]');
      expect(buffer.stdout).toContain('provider');
   });

   it('should show config path', async () => {
      const ctx = createGdxContext(tmpDir, ['gdx-config', 'path']);
      const result = await gdxConfig(ctx);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain(path.join(tmpRootDir, '.gdx', '.gdxrc.toml')); // Should contain temp dir path
   });

   it('should set a config value', async () => {
      const ctx = createGdxContext(tmpDir, ['gdx-config', 'llm.provider', 'openai']);
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
      const result = await gdxConfig(ctx);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain('openai');
   });

   it('should set experimental useInlineSubmodule value', async () => {
      const setCtx = createGdxContext(tmpDir, ['gdx-config', 'useInlineSubmodule', 'off']);
      expect(await gdxConfig(setCtx)).toBe(0);

      const getCtx = createGdxContext(tmpDir, ['gdx-config', 'useInlineSubmodule']);
      expect(await gdxConfig(getCtx)).toBe(0);
      expect(buffer.stdout).toContain('off');
   });

   it('should reject invalid useInlineSubmodule value', async () => {
      const invalidCtx = createGdxContext(tmpDir, [
         'gdx-config',
         'useInlineSubmodule',
         'invalid-value',
      ]);
      expect(await gdxConfig(invalidCtx)).toBe(1);
      expect(buffer.stderr).toContain('Expected one of off, internal, all');
   });

   it('should set and get commit.noisyFiles as string array', async () => {
      const setCtx = createGdxContext(tmpDir, [
         'gdx-config',
         'commit.noisyFiles',
         '["**/*.foo"]',
      ]);
      expect(await gdxConfig(setCtx)).toBe(0);

      const config = await getConfig();
      expect(config.get<string[]>('commit.noisyFiles', [])).toEqual(['**/*.foo']);
   });

   it('should handle invalid keys gracefully', async () => {
      const ctx = createGdxContext(tmpDir, ['gdx-config', 'invalid.key']);
      const result = await gdxConfig(ctx);

      // Code returns 1 if key is not set
      expect(result).toBe(1);
      expect(buffer.stdout).toContain('is not set');
   });
});
