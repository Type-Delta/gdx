import { describe, expect } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';

import { createGdxContext, createTestEnv } from '@/utils/testHelper';
import { buildStagedCommitDiffSummary } from '@/modules/diff-summary';
import { COMMIT_DEFAULT_NOISY_FILES } from '@/common/config/schema';

describe('commit-diff-summary module', async () => {
   const { tmpDir, $, it } = await createTestEnv();
   const { git$ } = createGdxContext(tmpDir, []);

   it('should return no changes when index is empty', async () => {
      const summary = await buildStagedCommitDiffSummary(git$);
      expect(summary.hasChanges).toBe(false);
      expect(summary.summary).toBe('');
   });

   it('should classify rename, non-text, noisy, and normal files', async () => {
      await fs.writeFile(path.join(tmpDir, 'rename-me.txt'), 'before\n', 'utf-8');
      await $`${git$} add rename-me.txt`;
      await $`${git$} commit -m ${'add rename source file'}`;

      await $`${git$} mv rename-me.txt renamed.txt`;
      await fs.writeFile(path.join(tmpDir, 'src.ts'), 'const a = 1;\nconst b = 2;\n', 'utf-8');
      await fs.writeFile(
         path.join(tmpDir, 'package-lock.json'),
         JSON.stringify(
            {
               name: 'demo',
               lockfileVersion: 3,
               packages: {
                  '': { version: '1.0.0' },
                  'node_modules/alpha': {
                     version: '1.0.0',
                     resolved: 'https://example.test/alpha',
                  },
                  'node_modules/beta': { version: '2.0.0', resolved: 'https://example.test/beta' },
               },
            },
            null,
            2
         ) + '\n',
         'utf-8'
      );
      await fs.writeFile(path.join(tmpDir, 'image.bin'), Buffer.from([0, 255, 10, 16, 3, 99]));

      await $`${git$} add renamed.txt src.ts package-lock.json image.bin`;

      const summary = await buildStagedCommitDiffSummary(git$);

      expect(summary.hasChanges).toBe(true);
      expect(summary.summary).toContain('<renames>');
      expect(summary.summary).toContain('rename-me.txt -> renamed.txt');
      expect(summary.summary).toContain('<binary-changes>');
      expect(summary.summary).toContain('image.bin');
      expect(summary.summary).toContain('<normal-text-diffs>');
      expect(summary.summary).toContain('src.ts');
      expect(summary.summary).toContain('<noisy-text-diffs>');
      expect(summary.summary).toContain('package-lock.json');
   });

   it('should classify files via configurable glob noisy patterns', async () => {
      await fs.writeFile(path.join(tmpDir, 'snapshot.foo'), 'alpha\n', 'utf-8');
      await $`${git$} add snapshot.foo`;

      const summary = await buildStagedCommitDiffSummary(git$, {
         noisyPatterns: ['**/*.foo'],
      });

      expect(summary.hasChanges).toBe(true);
      expect(summary.summary).toContain('<noisy-text-diffs>');
      expect(summary.summary).toContain('snapshot.foo');
   });

   it('should still fall back to commit default noisy glob patterns', async () => {
      await fs.writeFile(path.join(tmpDir, 'package-lock.json'), '{"name":"demo"}\n', 'utf-8');
      await $`${git$} add package-lock.json`;

      const summary = await buildStagedCommitDiffSummary(git$);

      expect(COMMIT_DEFAULT_NOISY_FILES.length).toBeGreaterThan(0);
      expect(summary.hasChanges).toBe(true);
      expect(summary.summary).toContain('<noisy-text-diffs>');
      expect(summary.summary).toContain('package-lock.json');
   });

   it('should omit pure whitespace-only file diffs', async () => {
      await fs.writeFile(path.join(tmpDir, 'space.txt'), 'alpha\nbeta\n', 'utf-8');
      await $`${git$} add space.txt`;
      await $`${git$} commit -m ${'add whitespace test file'}`;

      await fs.writeFile(path.join(tmpDir, 'space.txt'), 'alpha\n  beta\n', 'utf-8');
      await $`${git$} add space.txt`;

      const summary = await buildStagedCommitDiffSummary(git$);

      expect(summary.hasChanges).toBe(true);
      expect(summary.summary).toContain('<whitespace-only-changes>');
      expect(summary.summary).toContain('space.txt: only whitespace-only changes were detected.');
      expect(summary.summary).not.toContain('diff --git a/space.txt b/space.txt');
   });

   it('should preserve leading whitespace in kept context and changed lines', async () => {
      await fs.writeFile(path.join(tmpDir, 'indent.ts'), '  keep\n  old\n  tail\n', 'utf-8');
      await $`${git$} add indent.ts`;
      await $`${git$} commit -m ${'add indented file'}`;

      await fs.writeFile(path.join(tmpDir, 'indent.ts'), '  keep\n  new\n  tail\n', 'utf-8');
      await $`${git$} add indent.ts`;

      const summary = await buildStagedCommitDiffSummary(git$);

      expect(summary.hasChanges).toBe(true);
      expect(summary.summary).toContain('   keep');
      expect(summary.summary).toContain('-  old');
      expect(summary.summary).toContain('+  new');
   });

   it('should not mark multi-line redistribution as whitespace-only', async () => {
      await fs.writeFile(path.join(tmpDir, 'flow.ts'), 'foo();\nbar();\n', 'utf-8');
      await $`${git$} add flow.ts`;
      await $`${git$} commit -m ${'add flow source'}`;

      await fs.writeFile(path.join(tmpDir, 'flow.ts'), 'foo(bar());\n', 'utf-8');
      await $`${git$} add flow.ts`;

      const summary = await buildStagedCommitDiffSummary(git$);

      expect(summary.hasChanges).toBe(true);
      expect(summary.summary).not.toContain('<whitespace-only-changes>\n- flow.ts');
      expect(summary.summary).toContain('diff --git a/flow.ts b/flow.ts');
   });

   it('should hard-trim noisy diffs that exceed their file budget', async () => {
      const hugeLockContent = Array.from({ length: 140 }, (_, idx) => {
         return `  "dependency-${idx}": "${'x'.repeat(40)}"`;
      }).join(',\n');
      await fs.writeFile(
         path.join(tmpDir, 'package-lock.json'),
         `{"name":"demo","packages":{\n${hugeLockContent}\n}}\n`,
         'utf-8'
      );
      await $`${git$} add package-lock.json`;

      const summary = await buildStagedCommitDiffSummary(git$, {
         noisyFileCharCap: 30,
      });

      expect(summary.hasChanges).toBe(true);
      expect(summary.summary).toContain('hard-trimmed to 30 chars');
   });
});
