import { Err, strWrap } from '@lib/Tools';
import { CheckCache } from '@lib/Tools';
import * as fs from '@/modules/fs';
import {
   pagerWithRenderer,
   PagerRenderer,
   PagerOptions,
   getTerminalWidth,
   getTerminalHeight,
   clearTerminalCache,
   bgRgb,
   fgRgb,
   stripAnsiColor,
   getDisplayWidth,
   RESET,
   pager,
} from './pager';
import { colorMix } from './graphics';
import Logger from '@/utils/logger';
import { spinner } from './shell';

/** Catppuccin Mocha color palette */
const COLORS = {
   base: [30, 30, 46] as [number, number, number],
   mantle: [24, 24, 37] as [number, number, number],
   crust: [17, 17, 27] as [number, number, number],
   surface0: [49, 50, 68] as [number, number, number],
   surface1: [69, 71, 90] as [number, number, number],
   overlay0: [147, 153, 178] as [number, number, number],
   overlay1: [127, 132, 156] as [number, number, number],
   text: [205, 214, 244] as [number, number, number],
   green: [166, 227, 161] as [number, number, number],
   red: [243, 139, 168] as [number, number, number],
   yellow: [249, 226, 175] as [number, number, number],
   blue: [137, 180, 250] as [number, number, number],
   cyan: [148, 226, 213] as [number, number, number],
   lavender: [180, 190, 254] as [number, number, number],
};

const STYLES = {
   bold: (str: string) => `\x1b[1m${str}\x1b[22m`,
   italic: (str: string) => `\x1b[3m${str}\x1b[23m`,
   underline: (str: string) => `\x1b[4m${str}\x1b[24m`,
   dim: (str: string) => `\x1b[2m${str}\x1b[22m`,
}

/** Blended background colors for diff lines (translucent effect) */
const ADDED_BG = colorMix(COLORS.base, COLORS.green, 0.1);
const DELETED_BG = colorMix(COLORS.base, COLORS.red, 0.1);
const ADDED_GUTTER_BG = colorMix(COLORS.base, COLORS.green, 0.25);
const DELETED_GUTTER_BG = colorMix(COLORS.base, COLORS.red, 0.25);
const CONTEXT_BG = COLORS.base;

const THEME = 'catppuccin-mocha';

/** Options for the diff viewer */
export interface DiffViewerOptions extends PagerOptions {
   theme?: string;
   workingDir?: string;
}

interface DiffLine {
   type: 'add' | 'delete' | 'context' | 'header' | 'hunk' | 'file' | 'empty';
   content: string;
   oldLineNum?: number;
   newLineNum?: number;
   highlightedContent?: string;
}

interface ParsedDiff {
   fileName: string;
   oldFileName: string;
   newFileName: string;
   lang: BundledLanguage;
   lines: DiffLine[];
}

export type BundledLanguage = Parameters<typeof import('@shikijs/cli')['codeToANSI']>[1];

let shikiPromise: Promise<typeof import('@shikijs/cli')> | null = null;

async function getShiki(): Promise<typeof import('@shikijs/cli')> {
   shikiPromise ??= import('@shikijs/cli');
   return await shikiPromise;
}

export function canUseDiffViewer(): boolean {
   return process.stdout.isTTY === true && process.stdin.isTTY === true && CheckCache.supportsColor >= 3;
}

function detectLanguage(fileName: string): BundledLanguage {
   const ext = fileName.split('.').pop()?.toLowerCase() || '';
   const langMap: Record<string, string> = {
      ts: 'typescript',
      tsx: 'tsx',
      js: 'javascript',
      jsx: 'jsx',
      json: 'json',
      md: 'markdown',
      css: 'css',
      scss: 'scss',
      html: 'html',
      vue: 'vue',
      svelte: 'svelte',
      py: 'python',
      rb: 'ruby',
      go: 'go',
      rs: 'rust',
      java: 'java',
      kt: 'kotlin',
      swift: 'swift',
      c: 'c',
      cpp: 'cpp',
      h: 'c',
      hpp: 'cpp',
      sh: 'bash',
      bash: 'bash',
      zsh: 'bash',
      yml: 'yaml',
      yaml: 'yaml',
      toml: 'toml',
      xml: 'xml',
      sql: 'sql',
      dockerfile: 'dockerfile',
      docker: 'dockerfile',
      makefile: 'makefile',
      cmake: 'cmake',
      lua: 'lua',
      perl: 'perl',
      php: 'php',
   };
   return langMap[ext] as BundledLanguage || 'text';
}

function parseDiffOutput(diffText: string): ParsedDiff[] {
   const results: ParsedDiff[] = [];
   const lines = diffText.split('\n');
   let currentDiff: ParsedDiff | null = null;
   let oldLineNum = 0;
   let newLineNum = 0;

   for (const line of lines) {
      if (line.startsWith('diff --git ')) {
         if (currentDiff) results.push(currentDiff);
         const match = line.match(/diff --git a\/(.+?) b\/(.+)/);
         if (match) {
            currentDiff = {
               fileName: match[2],
               oldFileName: match[1],
               newFileName: match[2],
               lang: detectLanguage(match[2]),
               lines: [],
            };
         }
         continue;
      }
      if (!currentDiff) continue;

      if (line.startsWith('--- ') || line.startsWith('+++ ')) {
         currentDiff.lines.push({ type: 'header', content: line });
         continue;
      }
      if (line.startsWith('@@ ')) {
         const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
         if (match) {
            oldLineNum = parseInt(match[1], 10);
            newLineNum = parseInt(match[2], 10);
         }
         currentDiff.lines.push({ type: 'hunk', content: line });
         continue;
      }
      if (line[0] === '+') {
         currentDiff.lines.push({
            type: 'add',
            content: line.substring(1),
            newLineNum: newLineNum++,
         });
         continue;
      }
      if (line[0] === '-') {
         currentDiff.lines.push({
            type: 'delete',
            content: line.substring(1),
            oldLineNum: oldLineNum++,
         });
         continue;
      }
      if (line[0] === ' ' || line === '') {
         currentDiff.lines.push({
            type: 'context',
            content: line[0] === ' ' ? line.substring(1) : '',
            oldLineNum: oldLineNum++,
            newLineNum: newLineNum++,
         });
         continue;
      }
      if (line.match(/^(new file|deleted file|index|Binary|similarity|rename|old mode|new mode)/)) {
         currentDiff.lines.push({ type: 'header', content: line });
      }
   }
   if (currentDiff) results.push(currentDiff);
   return results;
}

async function readFileContext(
   filePath: string,
   changedLines: Set<number>,
   contextRadius: number,
   workingDir?: string
): Promise<Map<number, string>> {
   const contextLines = new Map<number, string>();
   if (changedLines.size === 0) return contextLines;
   try {
      const fullPath = workingDir ? `${workingDir}/${filePath}` : filePath;
      const content = await fs.readFile(fullPath, 'utf-8');
      const lines = content.split('\n');
      const minLine = Math.max(0, Math.min(...changedLines) - contextRadius);
      const maxLine = Math.min(lines.length - 1, Math.max(...changedLines) + contextRadius);
      for (let i = minLine; i <= maxLine; i++) {
         contextLines.set(i + 1, lines[i]);
      }
   } catch {
      /* File might not exist */
   }
   return contextLines;
}

async function highlightDiffWithContext(
   diff: ParsedDiff,
   theme: string,
   workingDir?: string
): Promise<Map<number, string>> {
   const result = new Map<number, string>();
   const codeLines = diff.lines.filter(
      (l) => l.type === 'add' || l.type === 'delete' || l.type === 'context'
   );
   if (codeLines.length === 0) return result;

   const changedLines = new Set<number>();
   codeLines.forEach((l) => {
      if (l.newLineNum) changedLines.add(l.newLineNum);
      if (l.oldLineNum) changedLines.add(l.oldLineNum);
   });

   const fileContext = await readFileContext(diff.newFileName, changedLines, 20, workingDir);

   try {
      Logger.debug(
         `Highlighting diff for ${diff.newFileName} with ${codeLines.length} changed lines and ${fileContext.size} lines of context from FS`,
         'diff-viewer'
      );

      const shiki = await Logger.timeAsync('Loading shiki module', getShiki, 'diff-viewer');
      if (fileContext.size > 0) {
         Logger.time('Highlighting diff');
         const minLine = Math.min(...fileContext.keys());
         const maxLine = Math.max(...fileContext.keys());
         const contextArray: string[] = [];
         for (let i = minLine; i <= maxLine; i++) contextArray.push(fileContext.get(i) || '');

         const highlighted = await shiki.codeToANSI(
            contextArray.join('\n'),
            diff.lang,
            theme as never
         );

         const highlightedLines = highlighted.split('\n');
         for (const line of codeLines) {
            const lineNum = line.newLineNum ?? line.oldLineNum;
            if (lineNum !== undefined) {
               const idx = lineNum - minLine;
               if (idx >= 0 && idx < highlightedLines.length)
                  result.set(lineNum, highlightedLines[idx]);
            }
         }
         Logger.timeEnd('Highlighting diff', 'diff-viewer');
      }
      else {
         Logger.debug(
            `No additional context from FS for ${diff.newFileName}, using what we have from git`,
            'diff-viewer'
         );

         Logger.time('Highlighting diff');
         const code = codeLines.map((l) => l.content).join('\n');
         const highlighted = await shiki.codeToANSI(code, diff.lang, theme as never);
         const highlightedLines = highlighted.split('\n');
         for (let i = 0; i < codeLines.length; i++) {
            if (highlightedLines[i]) {
               result.set(
                  codeLines[i].newLineNum ?? codeLines[i].oldLineNum ?? i,
                  highlightedLines[i]
               );
            }
         }
         Logger.timeEnd('Highlighting diff', 'diff-viewer');
      }
   } catch (e) {
      Logger.error(`Error highlighting diff for ${diff.newFileName}: ${Err.from(e)}`, 'diff-viewer');
      codeLines.forEach((line) =>
         result.set(line.newLineNum ?? line.oldLineNum ?? 0, line.content)
      );
   }
   return result;
}

export class DiffViewerRenderer implements PagerRenderer {
   private parsedDiffs: ParsedDiff[] = [];
   private renderedLines: string[] = [];
   private exitLines: string[] = [];
   private options: Required<DiffViewerOptions>;
   private lastWidth: number = 0;
   private lastHeight: number = 0;
   private logger = new Logger('diff-renderer');

   constructor(diffText: string, options: DiffViewerOptions = {}) {
      this.logger.debug('Initializing DiffViewerRenderer with options: ' + JSON.stringify(options));
      this.options = {
         showLineNumbers: true,
         lineNumberWidth: 5,
         wrapLines: true,
         showStatus: true,
         theme: THEME,
         statusFormat: (current, total) => {
            const endLine = Math.min(current + getTerminalHeight() - 2, total);
            return `lines ${current}-${endLine} of ${total}`;
         },
         backgroundColor: COLORS.mantle,
         workingDir: undefined,
         ...options,
      } as Required<DiffViewerOptions>;

      this.lastWidth = getTerminalWidth();
      this.lastHeight = getTerminalHeight();
      this.parsedDiffs = this.logger.time('Parsing diff output', () => parseDiffOutput(diffText));
      this.updateRenderedLines();
   }

   async prepareHighlighting(): Promise<void> {
      for (const diff of this.parsedDiffs) {
         const codeLines = diff.lines.filter(
            (l) => l.type === 'add' || l.type === 'delete' || l.type === 'context'
         );
         if (codeLines.length === 0) continue;
         const highlightedMap = await highlightDiffWithContext(
            diff,
            this.options.theme,
            this.options.workingDir
         );
         codeLines.forEach((line) => {
            const lineNum = line.newLineNum ?? line.oldLineNum;
            if (lineNum !== undefined && highlightedMap.has(lineNum)) {
               line.highlightedContent = highlightedMap.get(lineNum);
            }
         });
      }
      this.updateRenderedLines();
   }

   private renderLine(line: DiffLine, width: number, blockBg: [number, number, number]): string[] {
      const results: string[] = [];
      const lineNumWidth = this.options.lineNumberWidth;
      const contentWidth = width - lineNumWidth - 4;

      let sign = ' ';
      let bgCode: [number, number, number] = blockBg;
      let gutterBgCode: [number, number, number] = blockBg;
      let signColor = COLORS.overlay0;

      switch (line.type) {
         case 'add':
            sign = '+';
            bgCode = ADDED_BG;
            gutterBgCode = ADDED_GUTTER_BG;
            signColor = COLORS.green;
            break;
         case 'delete':
            sign = '-';
            bgCode = DELETED_BG;
            gutterBgCode = DELETED_GUTTER_BG;
            signColor = COLORS.red;
            break;
         case 'context':
            bgCode = CONTEXT_BG;
            break;
         case 'hunk':
            results.push(this.renderHunkHeader(line.content, width));
            return results;
         case 'header':
            results.push(this.renderFileHeader(line.content, width));
            return results;
         default:
            return results;
      }

      const displayContent = line.highlightedContent || line.content;
      const lineNum = line.newLineNum ?? line.oldLineNum;
      const lineNumStr =
         lineNum !== undefined ? String(lineNum).padStart(lineNumWidth) : ' '.repeat(lineNumWidth);
      const gutter = `${fgRgb(COLORS.overlay1)}${lineNumStr} ${fgRgb(signColor)}${sign} `;

      if (this.options.wrapLines && getDisplayWidth(displayContent) > contentWidth) {
         const wrapped = strWrap(displayContent, contentWidth, { mode: 'softboundary' });
         const splitted = wrapped.split('\n');
         for (let i = 0; i < splitted.length; i++) {
            const g = i === 0 ? gutter : ' '.repeat(lineNumWidth + 3);
            results.push(this.padLineWithBg(g + bgRgb(bgCode) + splitted[i], width, gutterBgCode));
         }
      } else {
         results.push(this.padLineWithBg(gutter + bgRgb(bgCode) + displayContent, width, gutterBgCode));
      }
      return results;
   }

   private padLineWithBg(str: string, width: number, bgColor: [number, number, number]): string {
      const stripped = stripAnsiColor(str);
      const padding = Math.max(0, width - stripped.length);
      return `${bgRgb(bgColor)}${str}${' '.repeat(padding)}${RESET}`;
   }

   private renderHunkHeader(
      content: string,
      width: number,
   ): string {
      const bgCode = colorMix(COLORS.crust, COLORS.surface0, 0.3);
      return this.padLineWithBg(`    ↕   ${fgRgb(COLORS.cyan)}${STYLES.italic(content)}`, width, bgCode);
   }

   private renderFileHeader(
      content: string,
      width: number,
   ): string {
      const bgCode = colorMix(COLORS.crust, COLORS.surface0, 0.3);
      return this.padLineWithBg(`      ${fgRgb(COLORS.overlay1)}${content}`, width, bgCode);
   }

   private renderFileName(oldName: string, newName: string, width: number): string {
      const bgCode = colorMix(COLORS.crust, COLORS.surface0, 0.3);
      if (oldName === newName) {
         return this.padLineWithBg(
            `    ${fgRgb(COLORS.lavender)}${STYLES.bold(newName)}`,
            width,
            bgCode
         );
      }
      return this.padLineWithBg(
         `    ${fgRgb(COLORS.yellow)}${oldName} -> ${newName}`,
         width,
         bgCode
      );
   }

   private updateRenderedLines(): void {
      Logger.time('Rendering diff lines');
      this.renderedLines = [];
      this.exitLines = [];
      const width = this.lastWidth;

      for (let i = 0; i < this.parsedDiffs.length; i++) {
         const diff = this.parsedDiffs[i];
         const blockBg = colorMix(COLORS.mantle, COLORS.surface0, 0.2);

         if (i !== 0) {
            this.renderedLines.push(
               this.padLineWithBg(' ', width, blockBg),
               this.padLineWithBg('      ' + fgRgb(COLORS.surface0) + '─'.repeat(width - 12), width, blockBg),
               this.padLineWithBg(' ', width, blockBg),
            );
         }
         this.renderedLines.push(this.renderFileName(diff.oldFileName, diff.newFileName, width));
         this.exitLines.push(`${fgRgb(COLORS.lavender)}${diff.newFileName}${RESET}`);

         for (const line of diff.lines) {
            this.renderedLines.push(...this.renderLine(line, width, blockBg));
            if (line.type === 'add')
               this.exitLines.push(`${fgRgb(COLORS.green)}+ ${line.content}${RESET}`);
            else if (line.type === 'delete')
               this.exitLines.push(`${fgRgb(COLORS.red)}- ${line.content}${RESET}`);
            else if (line.type === 'context') this.exitLines.push(`  ${line.content}`);
            else if (line.type === 'hunk')
               this.exitLines.push(`${fgRgb(COLORS.cyan)}${line.content}${RESET}`);
         }
      }
      Logger.timeEnd('Rendering diff lines', 'diff-viewer');
   }

   getLineCount(): number {
      return this.renderedLines.length;
   }
   getLine(index: number): string {
      return this.renderedLines[index] || '';
   }

   render(startLine: number, height: number, width: number): string[] {
      const result: string[] = [];
      const bgCode = bgRgb(this.options.backgroundColor);
      for (let i = 0; i < height - 1; i++) {
         const lineIndex = startLine + i;
         result.push(
            lineIndex < this.renderedLines.length
               ? this.renderedLines[lineIndex]
               : `${bgCode}${' '.repeat(width)}${RESET}`
         );
      }
      return result;
   }

   onResize(width: number, height: number): void {
      if (width !== this.lastWidth || height !== this.lastHeight) {
         this.lastWidth = width;
         this.lastHeight = height;
         this.updateRenderedLines();
      }
   }

   getExitLines(): string[] {
      return this.exitLines;
   }
}

export async function viewDiff(diffText: string, options: DiffViewerOptions = {}): Promise<void> {
   if (!canUseDiffViewer()) {
      Logger.warn(
         'Diff viewer is not supported in this environment. Falling back to plain output.',
         'diff-viewer'
      );
      return pager(diffText, { ...options, showLineNumbers: false });
   }

   const spinnerCtrl = diffText.length > 10000 ? spinner({
      message: 'Preparing diff viewer...',
      interval: 10,
   }) : undefined;

   Logger.time('Preparing diff highlighting');
   const renderer = new DiffViewerRenderer(diffText, options);
   await renderer.prepareHighlighting();
   clearTerminalCache();
   renderer.onResize(getTerminalWidth(), getTerminalHeight());
   Logger.timeEnd('Preparing diff highlighting', 'diff-viewer');

   spinnerCtrl?.stop();
   return pagerWithRenderer(renderer, options);
}

/**
 * Simple check to see if the text looks like git diff output. Not foolproof but good enough for deciding when to use the diff viewer.
 */
export function isGitDiffOutput(text: string): boolean {
   return /^diff --git a\/.+ b\/.+/.test(text);
}

export { parseDiffOutput };
