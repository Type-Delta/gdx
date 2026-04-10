import { describe, expect } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';

import { createGdxContext, createTestEnv } from '@/utils/testHelper';
import { buildStagedCommitDiffSummary } from '@/modules/diff-summary';
import { COMMIT_DEFAULT_NOISY_FILES } from '@/common/config/schema';

describe('commit-diff-summary module', async () => {
   const { tmpDir, $, it } = await createTestEnv({ suitName: 'diff-summary' });
   const { git$ } = createGdxContext(tmpDir, []);

   it('should return no changes when index is empty', async () => {
      const summary = await buildStagedCommitDiffSummary(git$);
      expect(summary.hasChanges).toBe(false);
      expect(summary.summary).toBe('');
   });

   it('should classify rename, copy, binary, noisy, and normal files in file-stats', async () => {
      await fs.writeFile(path.join(tmpDir, 'rename-me.txt'), 'before\n', 'utf-8');
      await fs.writeFile(
         path.join(tmpDir, 'copy-source.ts'),
         Array.from({ length: 30 }, (_, idx) => `export const value${idx} = ${idx};`).join('\n') +
         '\n',
         'utf-8'
      );
      await $`${git$} add rename-me.txt`;
      await $`${git$} add copy-source.ts`;
      await $`${git$} commit -m ${'add rename source file'}`;

      await $`${git$} mv rename-me.txt renamed.txt`;
      await fs.copyFile(path.join(tmpDir, 'copy-source.ts'), path.join(tmpDir, 'copied.ts'));
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

      await $`${git$} add renamed.txt copied.ts src.ts package-lock.json image.bin`;

      const summary = await buildStagedCommitDiffSummary(git$);

      expect(summary.hasChanges).toBe(true);
      expect(summary.summary).toContain('<summary-help-text>');
      expect(summary.summary).toContain('- copy: files detected as copies');
      expect(summary.summary).toContain('<file-stats>');
      expect(summary.summary).toContain('R [rename] rename-me.txt -> renamed.txt (identical)');
      expect(summary.summary).toContain('C [copy] copy-source.ts -> copied.ts (identical)');
      expect(summary.summary).toContain('[binary] image.bin (');
      expect(summary.summary).toContain('image.bin');
      expect(summary.summary).toContain('<normal-text-diffs>');
      expect(summary.summary).toContain('src.ts');
      expect(summary.summary).toContain('<noisy-text-diffs>');
      expect(summary.summary).toContain('package-lock.json');
      expect(summary.summary).not.toContain('<renames>');
      expect(summary.summary).not.toContain('<binary-changes>');
   });

   it('should include rename-diffs for drifted renames', async () => {
      await $`${git$} reset --hard HEAD`;
      await $`${git$} clean -fd`;

      await fs.writeFile(
         path.join(tmpDir, 'rename-drift.txt'),
         ['one', 'two', 'three', 'four'].join('\n') + '\n',
         'utf-8'
      );
      await $`${git$} add rename-drift.txt`;
      await $`${git$} commit -m ${'add rename drift source'}`;

      await $`${git$} mv rename-drift.txt renamed-drift.txt`;
      await fs.writeFile(
         path.join(tmpDir, 'renamed-drift.txt'),
         ['one', 'TWO', 'three', 'four', 'five'].join('\n') + '\n',
         'utf-8'
      );
      await $`${git$} add renamed-drift.txt`;

      const summary = await buildStagedCommitDiffSummary(git$);

      expect(summary.hasChanges).toBe(true);
      expect(summary.summary).toContain('<rename-diffs>');
      expect(summary.summary).toContain('diff --git a/rename-drift.txt b/renamed-drift.txt');
   });

   it('should include copy-diffs for drifted copies', async () => {
      await $`${git$} reset --hard HEAD`;
      await $`${git$} clean -fd`;

      await fs.writeFile(
         path.join(tmpDir, 'copy-drift-source.ts'),
         Array.from({ length: 40 }, (_, idx) => `export const token${idx} = '${idx}';`).join('\n') +
         '\n',
         'utf-8'
      );
      await $`${git$} add copy-drift-source.ts`;
      await $`${git$} commit -m ${'add copy drift source'}`;

      await fs.copyFile(
         path.join(tmpDir, 'copy-drift-source.ts'),
         path.join(tmpDir, 'copy-drift.ts')
      );
      await fs.writeFile(
         path.join(tmpDir, 'copy-drift.ts'),
         Array.from({ length: 40 }, (_, idx) => {
            if (idx === 5) return `export const token${idx} = 'changed';`;
            if (idx === 36) return `export const token${idx} = '${idx}-updated';`;
            return `export const token${idx} = '${idx}';`;
         }).join('\n') + '\n',
         'utf-8'
      );
      await $`${git$} add copy-drift.ts`;

      const summary = await buildStagedCommitDiffSummary(git$);

      expect(summary.hasChanges).toBe(true);
      expect(summary.summary).toContain('<copy-diffs>');
      expect(summary.summary).toContain('diff --git a/copy-drift-source.ts b/copy-drift.ts');
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
