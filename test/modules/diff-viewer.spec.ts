import { afterAll, describe, expect, mock } from 'bun:test';
import path from 'path';

import * as fs from '@/modules/fs';
import {
   DiffViewerRenderer,
   parseDiffOutput,
   canUseDiffViewer,
   BundledLanguage,
} from '@/modules/diff-viewer';
import { createTestEnv } from '@/utils/testHelper';
import { stripAnsiColor } from '@/modules/graphics';

mock.module('@shikijs/cli', () => ({
   codeToANSI: async (code: string) => code,
}));

describe('diff-viewer module', async () => {
   const { cleanup, it, tmpDir } = await createTestEnv();
   afterAll(cleanup);

   describe('parseDiffOutput', () => {
      it('should parse a simple diff', () => {
         const diffText = `diff --git a/test.ts b/test.ts
index 1234567..abcdefg 100644
--- a/test.ts
+++ b/test.ts
@@ -1,3 +1,4 @@
 const a = 1;
+const b = 2;
 const c = 3;
 const d = 4;`;

         const result = parseDiffOutput(diffText);

         expect(result.length).toBe(1);
         expect(result[0].fileName).toBe('test.ts');
         expect(result[0].oldFileName).toBe('test.ts');
         expect(result[0].lang).toBe('typescript');
      });

      it('should parse multiple files in diff', () => {
         const diffText = `diff --git a/file1.ts b/file1.ts
--- a/file1.ts
+++ b/file1.ts
@@ -1 +1 @@
-old
+new
diff --git a/file2.js b/file2.js
--- a/file2.js
+++ b/file2.js
@@ -1 +1 @@
-old
+new`;

         const result = parseDiffOutput(diffText);

         expect(result.length).toBe(2);
         expect(result[0].fileName).toBe('file1.ts');
         expect(result[1].fileName).toBe('file2.js');
      });

      it('should correctly identify added lines', () => {
         const diffText = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -0,0 +1,2 @@
+const a = 1;
+const b = 2;`;

         const result = parseDiffOutput(diffText);

         expect(result.length).toBe(1);
         const addLines = result[0].lines.filter((l) => l.type === 'add');
         expect(addLines.length).toBe(2);
         expect(addLines[0].content).toBe('const a = 1;');
         expect(addLines[0].newLineNum).toBe(1);
         expect(addLines[1].content).toBe('const b = 2;');
         expect(addLines[1].newLineNum).toBe(2);
      });

      it('should correctly identify deleted lines', () => {
         const diffText = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1,2 +0,0 @@
-const a = 1;
-const b = 2;`;

         const result = parseDiffOutput(diffText);

         expect(result.length).toBe(1);
         const deleteLines = result[0].lines.filter((l) => l.type === 'delete');
         expect(deleteLines.length).toBe(2);
         expect(deleteLines[0].content).toBe('const a = 1;');
         expect(deleteLines[0].oldLineNum).toBe(1);
      });

      it('should correctly identify context lines', () => {
         const diffText = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 4;`;

         const result = parseDiffOutput(diffText);

         const contextLines = result[0].lines.filter((l) => l.type === 'context');
         expect(contextLines.length).toBe(2);
         expect(contextLines[0].content).toBe('const a = 1;');
      });

      it('should detect correct language from file extension', () => {
         const testCases = [
            { file: 'test.ts', expectedLang: 'typescript' },
            { file: 'test.js', expectedLang: 'javascript' },
            { file: 'test.py', expectedLang: 'python' },
            { file: 'test.rs', expectedLang: 'rust' },
            { file: 'test.go', expectedLang: 'go' },
            { file: 'test.md', expectedLang: 'markdown' },
            { file: 'test.json', expectedLang: 'json' },
            { file: 'README', expectedLang: 'text' },
         ];

         for (const { file, expectedLang } of testCases) {
            const diffText = `diff --git a/${file} b/${file}
--- a/${file}
+++ b/${file}
@@ -0,0 +1 @@
+content`;

            const result = parseDiffOutput(diffText);
            expect(result[0].lang).toBe(expectedLang as BundledLanguage);
         }
      });

      it('should handle empty diff', () => {
         const result = parseDiffOutput('');
         expect(result.length).toBe(0);
      });

      it('should parse hunk headers correctly', () => {
         const diffText = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -10,5 +10,6 @@`;

         const result = parseDiffOutput(diffText);
         const hunkLines = result[0].lines.filter((l) => l.type === 'hunk');
         expect(hunkLines.length).toBe(1);
         expect(hunkLines[0].content).toBe('@@ -10,5 +10,6 @@');
      });

      it('should handle renamed files', () => {
         const diffText = `diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts`;

         const result = parseDiffOutput(diffText);
         expect(result.length).toBe(1);
         expect(result[0].oldFileName).toBe('old.ts');
         expect(result[0].newFileName).toBe('new.ts');
      });
   });

   describe('DiffViewerRenderer', () => {
      it('should create renderer with diff text', () => {
         const diffText = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1 +1 @@
-old
+new`;

         const renderer = new DiffViewerRenderer(diffText);
         expect(renderer).toBeDefined();
         expect(renderer.getLineCount()).toBeGreaterThan(0);
      });

      it('should render lines', () => {
         const diffText = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1 +1 @@
-old
+new`;

         const renderer = new DiffViewerRenderer(diffText);
         const lines = renderer.render(0, 6, 80);

         expect(Array.isArray(lines)).toBe(true);
         expect(lines.length).toBe(5);
      });

      it('should keep deleted line content when line numbers overlap', async () => {
         const diffText = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1,1 +1,1 @@
-import { ncc } from '@lib/Tools';
+import { Err, ncc } from '@lib/Tools';`;

         fs.writeFileSync(path.join(tmpDir, 'test.ts'), `import { Err, ncc } from '@lib/Tools';\n`);

         const renderer = new DiffViewerRenderer(diffText, { workingDir: tmpDir });
         await renderer.prepareHighlighting();

         const rendered = Array.from({ length: renderer.getLineCount() }, (_, i) =>
            stripAnsiColor(renderer.getLine(i))
         ).join('\n');

         expect(rendered).toContain("- import { ncc } from '@lib/Tools';");
         expect(rendered).toContain("+ import { Err, ncc } from '@lib/Tools';");
      });

      it('should handle resize', () => {
         const diffText = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1 +1 @@
-old
+new`;

         const renderer = new DiffViewerRenderer(diffText);

         renderer.onResize(100, 30);

         expect(renderer.getLineCount()).toBeGreaterThanOrEqual(0);
      });

      it('should get individual lines', () => {
         const diffText = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1 +1 @@
-old
+new`;

         const renderer = new DiffViewerRenderer(diffText);
         const line0 = renderer.getLine(0);

         expect(typeof line0).toBe('string');
      });
   });

   describe('canUseDiffViewer', () => {
      it('should return boolean', () => {
         const result = canUseDiffViewer();
         expect(typeof result).toBe('boolean');
      });
   });
});
