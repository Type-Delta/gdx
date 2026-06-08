import { describe, expect } from 'bun:test';
import path from 'path';
import fs from 'fs';

import gdxConfig from '@/commands/gdx-config';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';
import { getConfig } from '@/common/config';
import { DEFAULT_CONFIG } from '@/common/config/schema';

describe('gdx gdx-config', async () => {
   const { tmpDir, tmpRootDir, $, buffer, it } = await createTestEnv({
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

   it('should reset a config value to default with --unset', async () => {
      // Use a key that CI does not override via env vars. Keys like
      // useInlineGitConfig/useInlineSubmodule are forced via GDX_USE_INLINE_*
      // in CI (see .github/workflows/test.yml), and that env override masks the
      // reset default in the effective config, making this assertion fail in CI.
      const setCtx = createGdxContext(tmpDir, ['gdx-config', 'maxThreadWorkers', '4']);
      expect(await gdxConfig(setCtx)).toBe(0);

      const unsetCtx = createGdxContext(tmpDir, ['gdx-config', '--unset', 'maxThreadWorkers']);
      expect(await gdxConfig(unsetCtx)).toBe(0);
      expect(buffer.stdout).toContain('Configuration reset to default');

      const config = await getConfig();
      expect(config.get<typeof DEFAULT_CONFIG.maxThreadWorkers>('maxThreadWorkers')).toBe(
         DEFAULT_CONFIG.maxThreadWorkers
      );
   });

   it('should reset a config value to default when --unset follows the key', async () => {
      const setCtx = createGdxContext(tmpDir, ['gdx-config', 'defaultEditor', 'vim']);
      expect(await gdxConfig(setCtx)).toBe(0);

      const unsetCtx = createGdxContext(tmpDir, ['gdx-config', 'defaultEditor', '--unset']);
      expect(await gdxConfig(unsetCtx)).toBe(0);

      const config = await getConfig();
      expect(config.get<string>('defaultEditor')).toBe(DEFAULT_CONFIG.defaultEditor);
   });

   it('should reset a config value to default with -u alias', async () => {
      const setCtx = createGdxContext(tmpDir, ['gdx-config', 'enhancedOutput', 'false']);
      expect(await gdxConfig(setCtx)).toBe(0);

      const unsetCtx = createGdxContext(tmpDir, ['gdx-config', '-u', 'enhancedOutput']);
      expect(await gdxConfig(unsetCtx)).toBe(0);

      const config = await getConfig();
      expect(config.get<boolean>('enhancedOutput')).toBe(DEFAULT_CONFIG.enhancedOutput);
   });

   it('should reject unknown keys with --unset', async () => {
      const unsetCtx = createGdxContext(tmpDir, ['gdx-config', '--unset', 'invalid.key']);
      expect(await gdxConfig(unsetCtx)).toBe(1);
      expect(buffer.stderr).toContain("Unknown configuration key 'invalid.key'");
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
      expect(buffer.stderr).toContain("Expected one of 'off', 'internal', 'all'");
   });

   it('should set experimental useInlineGitConfig value', async () => {
      const setCtx = createGdxContext(tmpDir, ['gdx-config', 'useInlineGitConfig', 'off']);
      expect(await gdxConfig(setCtx)).toBe(0);

      const getCtx = createGdxContext(tmpDir, ['gdx-config', 'useInlineGitConfig']);
      expect(await gdxConfig(getCtx)).toBe(0);
      expect(buffer.stdout).toContain('off');
   });

   it('should reject invalid useInlineGitConfig value', async () => {
      const invalidCtx = createGdxContext(tmpDir, [
         'gdx-config',
         'useInlineGitConfig',
         'invalid-value',
      ]);
      expect(await gdxConfig(invalidCtx)).toBe(1);
      expect(buffer.stderr).toContain("Expected one of 'off', 'internal'");
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

   it('should validate comma-separated parallel.init values', async () => {
      const setCtx = createGdxContext(tmpDir, ['gdx-config', 'parallel.init', 'submodule,env,pkg']);
      expect(await gdxConfig(setCtx)).toBe(0);

      const config = await getConfig();
      expect(config.get<string>('parallel.init')).toBe('submodule,env,pkg');
   });

   it('should reject unknown comma-separated parallel.init values', async () => {
      const invalidCtx = createGdxContext(tmpDir, ['gdx-config', 'parallel.init', 'submodule,nope']);
      expect(await gdxConfig(invalidCtx)).toBe(1);
      expect(buffer.stderr).toContain("Invalid value for 'parallel.init'");
   });

   it('should write sparse local config and override global config', async () => {
      fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });

      const globalCtx = createGdxContext(tmpDir, ['gdx-config', 'llm.model', 'global-model']);
      expect(await gdxConfig(globalCtx)).toBe(0);

      const localCtx = createGdxContext(tmpDir, [
         'gdx-config',
         '--local',
         'llm.model',
         'local-model',
      ]);
      expect(await gdxConfig(localCtx)).toBe(0);

      const config = await getConfig();
      expect(config.get<string>('llm.model')).toBe('local-model');

      const localConfigPath = path.join(tmpDir, '.git', '.gdxrc.toml');
      const localConfig = fs.readFileSync(localConfigPath, 'utf-8');
      expect(localConfig).toContain('model = "local-model"');
      expect(localConfig).not.toContain('provider');
      expect(localConfig).not.toContain('defaultEditor');
   });

   it('should resolve local config path from a repository subdirectory', async () => {
      await $`git init`;
      const subdir = path.join(tmpDir, 'nested', 'dir');
      fs.mkdirSync(subdir, { recursive: true });

      const localCtx = createGdxContext(subdir, ['gdx-config', '--local', 'llm.model', 'sub-model']);
      expect(await gdxConfig(localCtx)).toBe(0);

      const localConfigPath = path.join(tmpDir, '.git', '.gdxrc.toml');
      const localConfig = fs.readFileSync(localConfigPath, 'utf-8');
      expect(localConfig).toContain('model = "sub-model"');
   });

   it('should resolve local config path from a worktree subdirectory', async () => {
      await $`git init`;
      await $`git config user.name ${'Test User'}`;
      await $`git config user.email ${'test@example.com'}`;
      await $`git commit --allow-empty --no-verify -m ${'Initial commit'}`;

      const worktreeDir = path.join(tmpRootDir, 'linked-worktree');
      await $`git worktree add -b ${'linked-test'} ${worktreeDir}`;
      const subdir = path.join(worktreeDir, 'nested');
      fs.mkdirSync(subdir, { recursive: true });

      const localCtx = createGdxContext(subdir, ['gdx-config', '--local', 'llm.model', 'worktree-model']);
      expect(await gdxConfig(localCtx)).toBe(0);

      const config = await getConfig();
      const localConfig = fs.readFileSync(config.getLocalConfigPath(), 'utf-8');
      expect(localConfig).toContain('model = "worktree-model"');
      expect(config.getLocalConfigPath()).toContain(path.join('.git', 'worktrees'));
   });

   it('should mark local overrides when listing config', async () => {
      fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });

      const localCtx = createGdxContext(tmpDir, ['gdx-config', '-l', 'lint.maxFileSizeKb', '2048']);
      expect(await gdxConfig(localCtx)).toBe(0);

      const listCtx = createGdxContext(tmpDir, ['gdx-config', 'list']);
      expect(await gdxConfig(listCtx)).toBe(0);
      expect(buffer.stdout).toContain('[LO] [Modified]');
      expect(buffer.stdout).toContain('maxFileSizeKb');
   });

   it('should reject unsupported local config keys', async () => {
      fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });

      const localCtx = createGdxContext(tmpDir, ['gdx-config', '--local', 'defaultEditor', 'vim']);
      expect(await gdxConfig(localCtx)).toBe(1);
      expect(buffer.stderr).toContain("Configuration key 'defaultEditor' cannot be set locally");
   });

   it('should handle invalid keys gracefully', async () => {
      const ctx = createGdxContext(tmpDir, ['gdx-config', 'invalid.key']);
      const result = await gdxConfig(ctx);

      // Code returns 1 if key is not set
      expect(result).toBe(1);
      expect(buffer.stdout).toContain('is not set');
   });
});
