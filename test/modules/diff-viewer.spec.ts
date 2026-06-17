import { describe, expect, mock } from 'bun:test';
import path from 'path';
import { CheckCache } from '@lib/Tools';

import * as fs from '@/modules/fs';
import {
   DiffViewerRenderer,
   parseDiffOutput,
   canUseDiffViewer,
   renderCommitMessageDiffLines,
   INDEX_REVISION,
   WORKING_TREE_REVISION,
} from '@/modules/diff-viewer';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';
import { stripAnsiColor } from '@/modules/graphics';
import { getConfig } from '@/common/config';
import Logger from '@/utils/logger';

let shikiLoadCount = 0;
let shikiCodeToANSICount = 0;

mock.module('@shikijs/cli', () => {
   shikiLoadCount++;
   return {
      codeToANSI: async (code: string) => {
         shikiCodeToANSICount++;
         return code.includes('// highlight-whole-file-probe')
            ? code
               .split('\n')
               .map((line, index) => `FULL:${index + 1}:${line}`)
               .join('\n')
            : code;
      },
   };
});

describe('diff-viewer module', async () => {
   const { it, tmpDir, $ } = await createTestEnv({ liteMode: false, suitName: 'diff-viewer' });

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
         expect(result[0].lang).toBe('plaintext');
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

      it('should default parsed language to plaintext before highlighting', () => {
         const testCases = [
            'test.ts',
            'test.js',
            'test.py',
            'test.rs',
            'test.go',
            'test.md',
            'test.json',
            'README',
         ];

         for (const file of testCases) {
            const diffText = `diff --git a/${file} b/${file}
--- a/${file}
+++ b/${file}
@@ -0,0 +1 @@
+content`;

            const result = parseDiffOutput(diffText);
            expect(result[0].lang).toBe('plaintext');
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

      it('should parse combined diff output', () => {
         const diffText = `diff --cc file.txt
index e69de29,1b2c3d4..5e6f7g8
--- a/file.txt
+++ b/file.txt
@@@ -0,0 -0,0 +1,2 @@@
+ +line one
+ +line two`;

         const result = parseDiffOutput(diffText);

         expect(result.length).toBe(1);
         expect(result[0].fileName).toBe('file.txt');
         const addLines = result[0].lines.filter((l) => l.type === 'add');
         expect(addLines.length).toBe(2);
      });

      it('should parse combined diff with multi-parent prefixes', () => {
         const diffText = `diff --cc file.txt
index e69de29,1b2c3d4,9a8b7c6..5e6f7g8
--- a/file.txt
+++ b/file.txt
@@@ -1,1 -1,1 -1,1 +1,1 @@@
+++line one
---line two
   line three`;

         const result = parseDiffOutput(diffText);

         expect(result.length).toBe(1);
         const addLines = result[0].lines.filter((l) => l.type === 'add');
         const deleteLines = result[0].lines.filter((l) => l.type === 'delete');
         const contextLines = result[0].lines.filter((l) => l.type === 'context');
         expect(addLines[0]?.content).toBe('line one');
         expect(deleteLines[0]?.content).toBe('line two');
         expect(contextLines[0]?.content).toBe('line three');
      });
   });

   describe('highlighting with context', () => {
      it('should highlight diff content when full-file context is unavailable', async () => {
         const diffText = `diff --git a/mismatch.ts b/mismatch.ts
--- a/mismatch.ts
+++ b/mismatch.ts
@@ -1,2 +1,2 @@
-alpha
+delta
 beta`;

         const renderer = new DiffViewerRenderer(diffText, { workingDir: tmpDir });
         await renderer.prepareHighlighting();

         const parsed = (renderer as unknown as { parsedDiffs: ReturnType<typeof parseDiffOutput> })
            .parsedDiffs;
         const changedLine = parsed[0]?.lines.find(
            (line) => line.type === 'modify' || line.type === 'add'
         );
         expect(changedLine?.highlightedContent).toBe('delta');
      });

      it('should highlight shown commits with full old and new file contents', async () => {
         await fs.writeFile(
            path.join(tmpDir, 'probe.ts'),
            `// highlight-whole-file-probe
const alpha = 1;
const beta = 2167 * 3;
`,
            'utf-8'
         );
         await $`git add probe.ts`;
         await $`git commit --no-verify -m ${'Add probe file'}`;
         const oldHash = (await $`git rev-parse HEAD`).stdout.trim();

         await fs.writeFile(
            path.join(tmpDir, 'probe.ts'),
            `// highlight-whole-file-probe
const alpha = 1;
const beta = 3165 + 346;
`,
            'utf-8'
         );
         await $`git add probe.ts`;
         await $`git commit --no-verify -m ${'Update probe file'}`;
         const newHash = (await $`git rev-parse HEAD`).stdout.trim();
         const diffText = (await $`git show --format= --no-ext-diff --no-color ${newHash}`).stdout;
         const ctx = createGdxContext(tmpDir);

         const renderer = new DiffViewerRenderer(diffText, {
            git$: ctx.git$,
            highlighting: {
               fullfileHighlight: true,
               oldRevision: oldHash,
               newRevision: newHash,
            },
         });
         await renderer.prepareHighlighting();

         const parsed = (renderer as unknown as { parsedDiffs: ReturnType<typeof parseDiffOutput> })
            .parsedDiffs;
         const deleteLine = parsed[0]?.lines.find((line) => line.type === 'delete');
         const addLine = parsed[0]?.lines.find((line) => line.type === 'add');

         expect(deleteLine?.highlightedContent).toBe('FULL:3:const beta = 2167 * 3;');
         expect(addLine?.highlightedContent).toBe('FULL:3:const beta = 3165 + 346;');

         const countAfterFirstHighlight = shikiCodeToANSICount;
         const cachedRenderer = new DiffViewerRenderer(diffText, {
            git$: ctx.git$,
            highlighting: {
               fullfileHighlight: true,
               oldRevision: oldHash,
               newRevision: newHash,
            },
         });
         await cachedRenderer.prepareHighlighting();

         expect(shikiCodeToANSICount).toBe(countAfterFirstHighlight);
      });

      it('should fall back to diff-context highlighting when file content exceeds maxHunkSize', async () => {
         const newHash = (await $`git rev-parse HEAD`).stdout.trim();
         const diffText = (await $`git show --format= --no-ext-diff --no-color ${newHash}`).stdout;
         const ctx = createGdxContext(tmpDir);
         const countBeforeHighlight = shikiCodeToANSICount;

         const renderer = new DiffViewerRenderer(diffText, {
            git$: ctx.git$,
            highlighting: {
               fullfileHighlight: true,
               oldRevision: `${newHash}^`,
               newRevision: newHash,
               maxHunkSize: 10,
            },
         });
         await renderer.prepareHighlighting();

         const parsed = (renderer as unknown as { parsedDiffs: ReturnType<typeof parseDiffOutput> })
            .parsedDiffs;
         const addLine = parsed[0]?.lines.find((line) => line.type === 'add');

         expect(addLine?.highlightedContent).toBe('FULL:3:const beta = 3165 + 346;');
         expect(shikiCodeToANSICount).toBeGreaterThan(countBeforeHighlight);
      });

      it('should highlight unstaged diffs with working tree file contents', async () => {
         await fs.writeFile(
            path.join(tmpDir, 'working-tree-probe.ts'),
            `// highlight-whole-file-probe
const alpha = 1;
const removedOnly = 10;
const keep = 1;
`,
            'utf-8'
         );
         await $`git add working-tree-probe.ts`;
         await $`git commit --no-verify -m ${'Add working tree probe file'}`;

         await fs.writeFile(
            path.join(tmpDir, 'working-tree-probe.ts'),
            `// highlight-whole-file-probe
const alpha = 1;
const keep = 1;
const addedOnly = 20;
`,
            'utf-8'
         );
         const diffText = (await $`git diff --no-ext-diff --no-color -- working-tree-probe.ts`).stdout;
         const ctx = createGdxContext(tmpDir);

         const renderer = new DiffViewerRenderer(diffText, {
            git$: ctx.git$,
            highlighting: {
               fullfileHighlight: true,
               oldRevision: 'HEAD',
               newRevision: WORKING_TREE_REVISION,
            },
         });
         await renderer.prepareHighlighting();

         const parsed = (renderer as unknown as { parsedDiffs: ReturnType<typeof parseDiffOutput> })
            .parsedDiffs;
         const deleteLine = parsed[0]?.lines.find((line) => line.type === 'delete');
         const addLine = parsed[0]?.lines.find((line) => line.type === 'add');

         expect(deleteLine?.highlightedContent).toBe('FULL:3:const removedOnly = 10;');
         expect(addLine?.highlightedContent).toBe('FULL:4:const addedOnly = 20;');
      });

      it('should highlight staged diffs with index file contents', async () => {
         await fs.writeFile(
            path.join(tmpDir, 'index-probe.ts'),
            `// highlight-whole-file-probe
const alpha = 1;
const removedOnly = 10;
const keep = 1;
`,
            'utf-8'
         );
         await $`git add index-probe.ts`;
         await $`git commit --no-verify -m ${'Add index probe file'}`;

         await fs.writeFile(
            path.join(tmpDir, 'index-probe.ts'),
            `// highlight-whole-file-probe
const alpha = 1;
const keep = 1;
const addedOnly = 20;
`,
            'utf-8'
         );
         await $`git add index-probe.ts`;
         const diffText = (await $`git diff --cached --no-ext-diff --no-color -- index-probe.ts`)
            .stdout;
         const ctx = createGdxContext(tmpDir);

         const renderer = new DiffViewerRenderer(diffText, {
            git$: ctx.git$,
            highlighting: {
               fullfileHighlight: true,
               oldRevision: 'HEAD',
               newRevision: INDEX_REVISION,
            },
         });
         await renderer.prepareHighlighting();

         const parsed = (renderer as unknown as { parsedDiffs: ReturnType<typeof parseDiffOutput> })
            .parsedDiffs;
         const deleteLine = parsed[0]?.lines.find((line) => line.type === 'delete');
         const addLine = parsed[0]?.lines.find((line) => line.type === 'add');

         expect(deleteLine?.highlightedContent).toBe('FULL:3:const removedOnly = 10;');
         expect(addLine?.highlightedContent).toBe('FULL:4:const addedOnly = 20;');
      });
   });

   describe('renderCommitMessageDiffLines', () => {
      it('should return patch-like lines without file headers', async () => {
         const lines = await renderCommitMessageDiffLines(
            'old subject\n\nold body line\n',
            'new subject\n\nnew body line\n'
         );

         expect(lines.length).toBeGreaterThan(0);
         expect(lines.some((line) => line.startsWith('diff --git'))).toBe(false);
         expect(lines.some((line) => line.startsWith('--- '))).toBe(false);
         expect(lines.some((line) => line.startsWith('+++ '))).toBe(false);
         expect(lines.some((line) => line.startsWith('@@ -'))).toBe(true);
         expect(lines.some((line) => line.includes('-old subject'))).toBe(true);
         expect(lines.some((line) => line.includes('+new subject'))).toBe(true);
      });

      it('should avoid loading shiki in truecolor commit-message mode', async () => {
         const prevColorLevel = CheckCache.supportsColor;
         CheckCache.supportsColor = 3;
         const beforeCount = shikiLoadCount;

         const lines = await renderCommitMessageDiffLines('alpha\n', 'beta\n');

         CheckCache.supportsColor = prevColorLevel;

         expect(lines.length).toBeGreaterThan(0);
         expect(shikiLoadCount).toBe(beforeCount);
      });
   });

   describe('DiffViewerRenderer', () => {
      it('should only write replacing debug snapshots in developer mode', async () => {
         const debugDirectory = path.join(tmpDir, 'diff-debug-snapshots');
         const parsedDiffPath = path.join(debugDirectory, 'parsed-diffs-debug.json');
         const renderedDiffPath = path.join(debugDirectory, 'diff-rendered-debug.json');
         const originalLogFile = Logger.logFile;
         const config = await getConfig();
         const diffText = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1 +1 @@
-const oldMarker = 1;
+const replacementMarker = 1;`;

         Logger.logFile = path.join(debugDirectory, 'gdx.log');
         await fs.rm(debugDirectory, { recursive: true, force: true });

         try {
            expect(config.get<boolean>('developerMode')).toBeFalse();
            const defaultRenderer = new DiffViewerRenderer(diffText, {
               disableSyntaxHighlighting: true,
            });
            await defaultRenderer.prepareHighlighting();
            await Bun.sleep(20);
            expect(fs.existsSync(parsedDiffPath)).toBeFalse();
            expect(fs.existsSync(renderedDiffPath)).toBeFalse();

            await config.set('developerMode', true);
            await fs.mkdir(debugDirectory, { recursive: true });
            await Promise.all([
               fs.writeFile(parsedDiffPath, 'stale parsed data', 'utf-8'),
               fs.writeFile(renderedDiffPath, 'stale rendered data', 'utf-8'),
            ]);

            const developerRenderer = new DiffViewerRenderer(diffText, {
               disableSyntaxHighlighting: true,
            });
            await developerRenderer.prepareHighlighting();

            for (let attempt = 0; attempt < 100; attempt++) {
               const renderedContent = await fs.readFile(renderedDiffPath, 'utf-8');
               if (renderedContent.includes('replacementMarker')) break;
               await Bun.sleep(5);
            }

            expect(await fs.readFile(parsedDiffPath, 'utf-8')).not.toContain('stale parsed data');
            const renderedContent = await fs.readFile(renderedDiffPath, 'utf-8');
            expect(renderedContent).toContain('replacementMarker');
            expect(renderedContent).not.toContain('stale rendered data');
         } finally {
            Logger.logFile = originalLogFile;
            await config.set('developerMode', false);
         }
      });

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

      it('should update line numbers while active', () => {
         const diffText = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1 +1 @@
-old
+new`;

         const renderer = new DiffViewerRenderer(diffText);
         const numberedLine = stripAnsiColor(
            Array.from({ length: renderer.getLineCount() }, (_, i) => renderer.getLine(i)).find(
               (line) => line.includes('old')
            ) || ''
         );

         expect(numberedLine).toMatch(/^\s+1 - old/);

         renderer.updateOptions({ showLineNumbers: false });
         const copyModeLine = stripAnsiColor(
            Array.from({ length: renderer.getLineCount() }, (_, i) => renderer.getLine(i)).find(
               (line) => line.includes('old')
            ) || ''
         );

         expect(copyModeLine).toStartWith('old');
      });

      it('should not add trailing ghost content for fullwidth', () => {
         const diffText = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1 +1 @@
-A
+漢`;

         const renderer = new DiffViewerRenderer(diffText, { wrapLines: true });
         const rendered = Array.from({ length: renderer.getLineCount() }, (_, i) =>
            stripAnsiColor(renderer.getLine(i))
         );
         const addLine = rendered.find((line) => line.includes('漢')) ?? '';
         expect(addLine.trimEnd().endsWith('漢')).toBeTrue();
      });

      it('should keep background padding for ascii-only diff lines', () => {
         const diffText = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1 +1 @@
-old value
+new value`;

         const renderer = new DiffViewerRenderer(diffText, { wrapLines: true });
         renderer.onResize(40, 20);

         const addLine = Array.from({ length: renderer.getLineCount() }, (_, i) =>
            renderer.getLine(i)
         ).find((line) => line.includes('new value'));

         expect(addLine).toBeString();
         expect(stripAnsiColor(addLine || '').length).toBe(40);
      });

      it('should strip CRLF carriage returns before rendering diff lines', () => {
         const diffText = [
            'diff --git a/test.md b/test.md',
            '--- a/test.md',
            '+++ b/test.md',
            '@@ -1,1 +1,1 @@',
            '-old value',
            '+new value',
         ].join('\r\n');

         const renderer = new DiffViewerRenderer(diffText, { wrapLines: true });
         renderer.onResize(40, 20);

         const rendered = Array.from({ length: renderer.getLineCount() }, (_, i) =>
            renderer.getLine(i)
         ).join('\n');

         expect(rendered).not.toContain('\r');
         expect(stripAnsiColor(rendered)).toContain('+ new value');
      });

      it('should keep deleted line content when line numbers overlap', async () => {
         const diffText = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1,1 +1,1 @@
-import { MathKit, ncc } from '@lib/Tools';
+import { Err, ncc } from '@lib/Tools';`;

         const renderer = new DiffViewerRenderer(diffText, { workingDir: tmpDir });
         await renderer.prepareHighlighting();

         const renderedRaw = Array.from({ length: renderer.getLineCount() }, (_, i) =>
            renderer.getLine(i)
         ).join('\n');
         const rendered = stripAnsiColor(renderedRaw);

         expect(rendered, 'deleted segment should exist').toContain('MathKit');
         expect(rendered, 'added segment should exist').toContain('Err, ncc');
         expect(rendered, 'unchanged segment should exist').toContain("} from '@lib/Tools';");
         expect(renderedRaw, 'should contain deleted line styling').toContain('\x1b[9m');
         expect(renderedRaw, 'should contain added line styling').toContain('\x1b[48;2;90;61;80m');
         expect(renderedRaw, 'should contain unchanged line styling').toContain('\x1b[48;2;68;85;78m');
      });

      it('should keep large replacement hunks split and style changed chars on each side', async () => {
         const diffText = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1,2 +1,2 @@
-const alpha = one + two;
-const beta = oldValue;
+const alpha = one + two + three;
+const beta = newValue;`;

         const renderer = new DiffViewerRenderer(diffText);
         await renderer.prepareHighlighting();

         const renderedLines = Array.from({ length: renderer.getLineCount() }, (_, i) =>
            renderer.getLine(i)
         );
         const plainRendered = renderedLines.map((line) => stripAnsiColor(line)).join('\n');

         expect(plainRendered).toContain('- const alpha = one + two;');
         expect(plainRendered).toContain('+ const alpha = one + two + three;');

         const deleteLine =
            renderedLines.find((line) =>
               stripAnsiColor(line).includes('- const beta = oldValue;')
            ) || '';
         const addLine =
            renderedLines.find((line) =>
               stripAnsiColor(line).includes('+ const beta = newValue;')
            ) || '';

         expect(deleteLine).toContain('\x1b[48;2;90;61;80m');
         expect(deleteLine).not.toContain('\x1b[9m');
         expect(addLine).toContain('\x1b[48;2;68;85;78m');
      });

      it('should preserve unmatched remaining deleted and added lines in large replacement block', async () => {
         const diffText = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1,6 +1,3 @@
-const a = 1;
-const b = 2;
-const c = 3;
-const d = 4;
-const e = 5;
-const f = 6;
+const a = 10;
+const b = 20;
+const c = 30;`;

         const renderer = new DiffViewerRenderer(diffText);
         await renderer.prepareHighlighting();

         const rendered = Array.from({ length: renderer.getLineCount() }, (_, i) =>
            stripAnsiColor(renderer.getLine(i))
         ).join('\n');

         expect(rendered).toContain('- const f = 6;');
         expect(rendered).toContain('+ const c = 30;');
      });

      it('should merge nearby inline changes across adjacent lines', async () => {
         const diffText = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1,2 +1,2 @@
-abcdefghijklmno
-uvwxyz
+abcdefghijklmXo
+uvQxyz`;

         const renderer = new DiffViewerRenderer(diffText);
         await renderer.prepareHighlighting();

         const parsed = (renderer as unknown as { parsedDiffs: ReturnType<typeof parseDiffOutput> })
            .parsedDiffs;
         const addLines = parsed[0]?.lines.filter((line) => line.type === 'add') || [];

         expect(addLines.length).toBe(2);
         expect(addLines[0]?.inlineSegments?.[addLines[0].inlineSegments.length - 1]?.type).toBe(
            'add'
         );
         expect(addLines[1]?.inlineSegments?.[0]?.type).toBe('add');
      });

      it('should preserve unchanged characters between add segments on modify lines', async () => {
         const oldLine =
            '    "package:node": "bun run transpile-esm && bun build ./src/index.ts --outdir=./dist --target=node --external=keytar --external=cspell-lib --external=@shikijs/cli --external=yaml --format=esm --production --keep-names",';
         const newLine =
            '    "package:node": "bun run transpile-esm && bun build ./src/index.ts --outdir=./dist --target=node --external=keytar --external=cspell-lib --external=@shikijs/cli --external=yaml --external=fflate --format=esm --production --keep-names",';
         const diffText = `diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -44,1 +44,1 @@
-${oldLine}
+${newLine}`;

         const renderer = new DiffViewerRenderer(diffText, { disableSyntaxHighlighting: true });
         await renderer.prepareHighlighting();

         const parsed = (renderer as unknown as { parsedDiffs: ReturnType<typeof parseDiffOutput> })
            .parsedDiffs;
         const modifyLine = parsed[0]?.lines.find((line) => line.type === 'modify');
         const withoutAddedSegments = modifyLine?.inlineSegments
            ?.filter((segment) => segment.type !== 'add')
            .map((segment) => segment.value)
            .join('');

         expect(modifyLine?.content).toBe(newLine);
         expect(withoutAddedSegments).toBe(oldLine);
      });

      it('should preserve syntax highlight while overlaying inline diff backgrounds', async () => {
         const diffText = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1,1 +1,1 @@
-const alpha = oldValue;
+const alpha = newValue;`;

         const renderer = new DiffViewerRenderer(diffText);
         await renderer.prepareHighlighting();

         const parsed = (renderer as unknown as { parsedDiffs: ReturnType<typeof parseDiffOutput> })
            .parsedDiffs;
         const modifyLine = parsed[0]?.lines.find((line) => line.type === 'modify');
         expect(modifyLine).toBeDefined();

         if (!modifyLine) throw new Error('Expected modify line');

         modifyLine.highlightedContent = `\x1b[38;2;166;227;161m${modifyLine.content}\x1b[0m`;
         (renderer as unknown as { updateRenderedLines: () => void }).updateRenderedLines();

         const renderedRaw = Array.from({ length: renderer.getLineCount() }, (_, i) =>
            renderer.getLine(i)
         ).join('\n');

         expect(renderedRaw).toContain('\x1b[38;2;166;227;161m');
         expect(renderedRaw).toContain('\x1b[48;2;68;85;78m');
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
