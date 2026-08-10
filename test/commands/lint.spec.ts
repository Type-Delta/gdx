import litedent from 'litedent';
import { describe, expect } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';

import lint from '@/commands/lint';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';
import { getConfig } from '@/common/config';

describe('gdx lint', async () => {
   const { tmpDir, $, buffer, it } = await createTestEnv({
      suitName: 'lint',
   });
   const ctx = createGdxContext(tmpDir, ['lint']);
   const { git$ } = ctx;

   it(
      'should pass on clean commit',
      async () => {
         // Initial commit
         await $`${git$} commit --allow-empty --no-verify -m ${'feat: initial commit'}`;

         const result = await lint(ctx);
         expect(result).toBe(0);
         expect(buffer.stdout).toContain('No problems found');
      },
      { timeout: 20000 }
   );

   it('should detect spelling errors', async () => {
      // "commmit" is a typo
      await $`${git$} commit --allow-empty --no-verify -m ${'feat: this has a commmit typo'}`;

      const result = await lint(ctx);
      expect(result).toBe(0); // Warnings don't fail the command
      expect(buffer.stdout).toContain('LWARN');
      expect(buffer.stdout).toContain('Spelling');
      expect(buffer.stdout).toContain('commmit');
   });

   it('should accept words listed in .vscode/settings.json', async () => {
      await fs.mkdir(path.join(tmpDir, '.vscode'), { recursive: true });
      await fs.writeFile(
         path.join(tmpDir, '.vscode', 'settings.json'),
         // Trailing comma and comment on purpose: settings.json is JSONC.
         '{\n   // project terms\n   "cSpell.words": ["Catppuccin", "medoid"],\n}\n'
      );

      await $`${git$} commit --allow-empty --no-verify -m ${'feat: tune Catppuccin medoid palette'}`;

      const result = await lint(ctx);
      expect(result).toBe(0);
      expect(buffer.stdout).toContain('No problems found');
      expect(buffer.stdout).not.toContain('Spelling');
   });

   it('should still flag typos that the local wordlist does not cover', async () => {
      await $`${git$} commit --allow-empty --no-verify -m ${'feat: Catppuccin theme has a commmit typo'}`;

      const result = await lint(ctx);
      expect(result).toBe(0);
      expect(buffer.stdout).toContain('Spelling');
      expect(buffer.stdout).toContain('commmit');
      // Only the typo is reported; the wordlisted term shows up as context, not as an issue.
      expect(buffer.stdout).toContain('Found 1 spelling issue');
   });

   it('should detect sensitive content', async () => {
      await fs.writeFile(
         path.join(tmpDir, 'secret.txt'),
         'api_key = "sk-12345678901234567890123456789012"'
      );
      await $`${git$} add secret.txt`;
      await $`${git$} commit --allow-empty --no-verify -m ${'feat: add secret'}`;

      const result = await lint(ctx);
      expect(result).toBe(1); // Errors fail the command
      expect(buffer.stdout).toContain('LERROR');
      expect(buffer.stdout).toContain('Sensitive Content');
      expect(buffer.stdout).toContain('secret.txt');
   });

   it('should detect conflict markers', async () => {
      const content = litedent`
         <<<<<<< HEAD
         current change
         =======
         incoming change
         >>>>>>> branch
      `;
      await fs.writeFile(path.join(tmpDir, 'conflict.txt'), content);
      await $`${git$} add conflict.txt`;
      await $`${git$} commit --no-verify -m ${'feat: add conflict'}`;

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
      await $`${git$} add large.bin`;
      await $`${git$} commit --no-verify -m ${'feat: add large file'}`;

      const result = await lint(ctx);
      expect(result).toBe(0); // Warnings don't fail
      expect(buffer.stdout).toContain('LWARN');
      expect(buffer.stdout).toContain('Size');
      expect(buffer.stdout).toContain('large.bin');
   });
});
