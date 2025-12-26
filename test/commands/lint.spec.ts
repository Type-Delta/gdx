
import { afterAll, describe, expect } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';

import lint from '@/commands/lint';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';
import dedent from 'dedent';
import { getConfig } from '@/common/config';

describe('gdx lint', async () => {
   const { tmpDir, $, buffer, cleanup, it } = await createTestEnv();
   const ctx = createGdxContext(tmpDir, ['lint']);
   afterAll(cleanup);

   it('should pass on clean commit', async () => {
      // Initial commit
      await fs.writeFile(path.join(tmpDir, 'file.txt'), 'clean content');
      await $`git add file.txt`;
      await $`git commit -m ${'feat: initial commit'}`;

      const result = await lint(ctx);
      expect(result).toBe(0);
      expect(buffer.stdout).toContain('No problems found');
   });

   it('should detect spelling errors', async () => {
      await fs.writeFile(path.join(tmpDir, 'typo.txt'), 'content');
      await $`git add typo.txt`;
      // "commmit" is a typo
      await $`git commit -m ${'feat: this has a commmit typo'}`;

      const result = await lint(ctx);
      expect(result).toBe(0); // Warnings don't fail the command
      expect(buffer.stdout).toContain('LWARN');
      expect(buffer.stdout).toContain('Spelling');
      expect(buffer.stdout).toContain('commmit');
   });

   it('should detect sensitive content', async () => {
      await fs.writeFile(path.join(tmpDir, 'secret.txt'), 'api_key = "sk-12345678901234567890123456789012"');
      await $`git add secret.txt`;
      await $`git commit -m ${'feat: add secret'}`;

      const result = await lint(ctx);
      expect(result).toBe(1); // Errors fail the command
      expect(buffer.stdout).toContain('LERROR');
      expect(buffer.stdout).toContain('Sensitive Content');
      expect(buffer.stdout).toContain('secret.txt');
   });

   it('should detect conflict markers', async () => {
      const content = dedent`
         <<<<<<< HEAD
         current change
         =======
         incoming change
         >>>>>>> branch
      `;
      await fs.writeFile(path.join(tmpDir, 'conflict.txt'), content);
      await $`git add conflict.txt`;
      await $`git commit -m ${'feat: add conflict'}`;

      const result = await lint(ctx);
      expect(result).toBe(1);
      expect(buffer.stdout).toContain('LERROR');
      expect(buffer.stdout).toContain('Conflict Markers');
   });

   it('should detect large files', async () => {
      // Create a file slightly larger than 1MB (default limit is 1024KB)
      const config = await getConfig();
      const maxFileSizeKb = config.get<number>('lint.maxFileSizeKb') || 1024;

      const largeContent = Buffer.alloc(maxFileSizeKb * 1025, 'a');
      await fs.writeFile(path.join(tmpDir, 'large.bin'), largeContent);
      await $`git add large.bin`;
      await $`git commit -m ${'feat: add large file'}`;

      const result = await lint(ctx);
      expect(result).toBe(0); // Warnings don't fail
      expect(buffer.stdout).toContain('LWARN');
      expect(buffer.stdout).toContain('Size');
      expect(buffer.stdout).toContain('large.bin');
   });
});
