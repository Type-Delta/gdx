import { Err, ncc, strWrap } from '@lib/Tools';
import { CheckCache } from '@lib/Tools';
import * as fs from '@/modules/fs';

import {
   pagerWithRenderer,
   PagerRenderer,
   PagerOptions,
   getTerminalWidth,
   getTerminalHeight,
   clearTerminalCache,
   pager,
} from './pager';
import { bgRgb, colorMix, fgRgb, getDisplayWidth, RgbVec, stripAnsiColor } from './graphics';
import Logger from '@/utils/logger';
import { spinner } from './shell';
import { CATPPUCCIN_VPALETTE, TUI_THEME } from '@/consts';

const STYLES = {
   bold: (str: string) => `\x1b[1m${str}\x1b[22m`,
   italic: (str: string) => `\x1b[3m${str}\x1b[23m`,
   underline: (str: string) => `\x1b[4m${str}\x1b[24m`,
   dim: (str: string) => `\x1b[2m${str}\x1b[22m`,
};

const DIFF_HEADER_LINE_REGEX = /^diff --(git|cc|combined)\b/;
const DIFF_HEADER_TEXT_REGEX = /^diff --(git|cc|combined)\b/m;

/** Options for the diff viewer */
export interface DiffViewerOptions extends PagerOptions {
   theme?: string;
   workingDir?: string;
   preambleLines?: string[];
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

export type BundledLanguage = Parameters<(typeof import('@shikijs/cli'))['codeToANSI']>[1];

let shikiPromise: Promise<typeof import('@shikijs/cli')> | null = null;

async function getShiki(): Promise<typeof import('@shikijs/cli')> {
   shikiPromise ??= import('@shikijs/cli');
   return await shikiPromise;
}

/**
 * Checks if the current environment supports rendering the diff viewer (i.e. both stdin and stdout are TTY and terminal supports truecolor).
 */
export function canUseDiffViewer(): boolean {
   return (
      process.stdout.isTTY === true && process.stdin.isTTY === true && CheckCache.supportsColor >= 3
   );
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
   return (langMap[ext] as BundledLanguage) || 'text';
}

function parseDiffOutput(diffText: string): ParsedDiff[] {
   const results: ParsedDiff[] = [];
   const lines = diffText.split('\n');
   let currentDiff: ParsedDiff | null = null;
   let oldLineNum = 0;
   let newLineNum = 0;
   let isCombinedDiff = false;

   for (const line of lines) {
      if (DIFF_HEADER_LINE_REGEX.test(line)) {
         if (currentDiff) results.push(currentDiff);
         const diffHeader = parseDiffHeader(line);
         if (diffHeader) {
            currentDiff = {
               fileName: diffHeader.fileName,
               oldFileName: diffHeader.oldFileName,
               newFileName: diffHeader.newFileName,
               lang: detectLanguage(diffHeader.fileName),
               lines: [],
            };
            isCombinedDiff = diffHeader.isCombined;
         } else {
            currentDiff = null;
            isCombinedDiff = false;
         }
         continue;
      }
      if (!currentDiff) continue;

      if (line.startsWith('--- ') || line.startsWith('+++ ')) {
         currentDiff.lines.push({ type: 'header', content: line });
         continue;
      }
      if (line.startsWith('@@@ ')) {
         const oldMatch = line.match(/@@@ -(\d+)(?:,\d+)?/);
         const newMatch = line.match(/\+(\d+)(?:,\d+)? @@@/);
         if (oldMatch) oldLineNum = parseInt(oldMatch[1], 10);
         if (newMatch) newLineNum = parseInt(newMatch[1], 10);
         currentDiff.lines.push({ type: 'hunk', content: line });
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
      if (isCombinedDiff) {
         const combinedLineMatch = line.match(/^([ +-]{2,})(.*)$/);
         if (combinedLineMatch) {
            const prefix = combinedLineMatch[1];
            const content = combinedLineMatch[2];
            const hasPlus = prefix.includes('+');
            const hasMinus = prefix.includes('-');
            const type: DiffLine['type'] =
               hasPlus && !hasMinus ? 'add' : hasMinus && !hasPlus ? 'delete' : 'context';
            const parsedLine: DiffLine = {
               type,
               content,
            };
            if (type === 'add') parsedLine.newLineNum = newLineNum++;
            else if (type === 'delete') parsedLine.oldLineNum = oldLineNum++;
            else {
               parsedLine.oldLineNum = oldLineNum++;
               parsedLine.newLineNum = newLineNum++;
            }
            currentDiff.lines.push(parsedLine);
            continue;
         }
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
): Promise<Map<DiffLine, string>> {
   const result = new Map<DiffLine, string>();
   const codeLines = diff.lines.filter(
      (l) => l.type === 'add' || l.type === 'delete' || l.type === 'context'
   );
   if (codeLines.length === 0) return result;

   const newLines = codeLines.filter((line) => line.type !== 'delete');
   const deletedLines = codeLines.filter((line) => line.type === 'delete');

   try {
      const shiki = await getShiki();
      if (newLines.length > 0) {
         const changedLines = new Set<number>();
         newLines.forEach((line) => {
            if (line.newLineNum !== undefined) changedLines.add(line.newLineNum);
         });

         const fileContext = await readFileContext(diff.newFileName, changedLines, 20, workingDir);

         Logger.debug(
            `Highlighting diff for ${diff.newFileName} with ${codeLines.length} changed lines and ${fileContext.size} lines of context from FS`,
            'diff-viewer'
         );

         if (fileContext.size > 0) {
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
            for (const line of newLines) {
               const lineNum = line.newLineNum;
               if (lineNum !== undefined) {
                  const idx = lineNum - minLine;
                  if (idx >= 0 && idx < highlightedLines.length)
                     result.set(line, highlightedLines[idx]);
               }
            }
         } else {
            Logger.debug(
               `No additional context from FS for ${diff.newFileName}, using what we have from git`,
               'diff-viewer'
            );

            const code = newLines.map((line) => line.content).join('\n');
            const highlighted = await shiki.codeToANSI(code, diff.lang, theme as never);
            const highlightedLines = highlighted.split('\n');
            for (let i = 0; i < newLines.length; i++) {
               if (highlightedLines[i]) result.set(newLines[i], highlightedLines[i]);
            }
         }
      }

      if (deletedLines.length > 0) {
         const code = deletedLines.map((line) => line.content).join('\n');
         const highlighted = await shiki.codeToANSI(code, diff.lang, theme as never);
         const highlightedLines = highlighted.split('\n');
         for (let i = 0; i < deletedLines.length; i++) {
            if (highlightedLines[i]) result.set(deletedLines[i], highlightedLines[i]);
         }
      }
   } catch (e) {
      Logger.error(
         `Error highlighting diff for ${diff.newFileName}: ${Err.from(e)}`,
         'diff-viewer'
      );
      codeLines.forEach((line) => result.set(line, line.content));
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

   /** Blended background colors for diff lines (translucent effect) */
   private readonly ADDED_BG = colorMix(CATPPUCCIN_VPALETTE.base, CATPPUCCIN_VPALETTE.green, 0.15);
   private readonly DELETED_BG = colorMix(CATPPUCCIN_VPALETTE.base, CATPPUCCIN_VPALETTE.red, 0.15);
   private readonly ADDED_GUTTER_BG = colorMix(
      CATPPUCCIN_VPALETTE.base,
      CATPPUCCIN_VPALETTE.green,
      0.25
   );
   private readonly DELETED_GUTTER_BG = colorMix(
      CATPPUCCIN_VPALETTE.base,
      CATPPUCCIN_VPALETTE.red,
      0.25
   );

   constructor(diffText: string, options: DiffViewerOptions = {}) {
      this.logger.debug('Initializing DiffViewerRenderer with options: ' + JSON.stringify(options));
      this.options = {
         showLineNumbers: true,
         lineNumberWidth: 5,
         wrapLines: true,
         showStatus: true,
         theme: TUI_THEME,
         statusFormat: (current, total) => {
            const endLine = Math.min(current + getTerminalHeight() - 2, total);
            return `lines ${current}-${endLine} of ${total}`;
         },
         backgroundColor: CATPPUCCIN_VPALETTE.mantle,
         workingDir: undefined,
         preambleLines: [],
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
            const highlighted = highlightedMap.get(line);
            if (highlighted !== undefined) line.highlightedContent = highlighted;
         });
      }
      this.updateRenderedLines();
   }

   private renderLine(line: DiffLine, width: number, blockBg: RgbVec): string[] {
      const results: string[] = [];
      const lineNumWidth = this.options.lineNumberWidth;
      const contentWidth = width - lineNumWidth - 4;

      let sign = ' ';
      let bgCode: RgbVec = blockBg;
      let gutterBgCode: RgbVec = blockBg;
      let signColor = CATPPUCCIN_VPALETTE.overlay0 as RgbVec;

      switch (line.type) {
         case 'add':
            sign = '+';
            bgCode = this.ADDED_BG;
            gutterBgCode = this.ADDED_GUTTER_BG;
            signColor = CATPPUCCIN_VPALETTE.green;
            break;
         case 'delete':
            sign = '-';
            bgCode = this.DELETED_BG;
            gutterBgCode = this.DELETED_GUTTER_BG;
            signColor = CATPPUCCIN_VPALETTE.red;
            break;
         case 'context':
            bgCode = CATPPUCCIN_VPALETTE.base;
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
      const gutter = `${fgRgb(CATPPUCCIN_VPALETTE.overlay1)}${lineNumStr} ${fgRgb(signColor)}${sign} `;

      if (this.options.wrapLines && getDisplayWidth(displayContent) > contentWidth) {
         const wrapped = strWrap(displayContent, contentWidth, { mode: 'softboundary' });
         const splitted = wrapped.split('\n');
         for (let i = 0; i < splitted.length; i++) {
            const g = i === 0 ? gutter : ' '.repeat(lineNumWidth + 3);
            results.push(this.padLineWithBg(g + bgRgb(bgCode) + splitted[i], width, gutterBgCode));
         }
      } else {
         results.push(
            this.padLineWithBg(gutter + bgRgb(bgCode) + displayContent, width, gutterBgCode)
         );
      }
      return results;
   }

   private padLineWithBg(str: string, width: number, bgColor: RgbVec): string {
      const stripped = stripAnsiColor(str);
      const padding = Math.max(0, width - stripped.length);
      return `${bgRgb(bgColor)}${str}${' '.repeat(padding)}${ncc()}`;
   }

   private renderHunkHeader(content: string, width: number): string {
      const bgCode = colorMix(CATPPUCCIN_VPALETTE.crust, CATPPUCCIN_VPALETTE.surface0, 0.3);
      return this.padLineWithBg(
         `    ↕   ${fgRgb(CATPPUCCIN_VPALETTE.cyan)}${STYLES.italic(content)}`,
         width,
         bgCode
      );
   }

   private renderFileHeader(content: string, width: number): string {
      const bgCode = colorMix(CATPPUCCIN_VPALETTE.crust, CATPPUCCIN_VPALETTE.surface0, 0.3);
      return this.padLineWithBg(
         `      ${fgRgb(CATPPUCCIN_VPALETTE.overlay1)}${content}`,
         width,
         bgCode
      );
   }

   private renderFileName(oldName: string, newName: string, width: number): string {
      const bgCode = colorMix(CATPPUCCIN_VPALETTE.crust, CATPPUCCIN_VPALETTE.surface0, 0.3);
      if (oldName === newName) {
         return this.padLineWithBg(
            `    ${fgRgb(CATPPUCCIN_VPALETTE.lavender)}${STYLES.bold(newName)}`,
            width,
            bgCode
         );
      }
      return this.padLineWithBg(
         `    ${fgRgb(CATPPUCCIN_VPALETTE.yellow)}${oldName} -> ${newName}`,
         width,
         bgCode
      );
   }

   private renderPreambleLine(
      line: string,
      width: number,
      blockBg: RgbVec,
      leftPadding: number
   ): string[] {
      if (!line) return [this.padLineWithBg(' ', width, blockBg)];
      line = ' '.repeat(leftPadding) + line; // Indent preamble lines to align with diff content
      const contentWidth = width;
      const color = fgRgb(CATPPUCCIN_VPALETTE.overlay1);

      if (this.options.wrapLines && getDisplayWidth(line) > contentWidth) {
         const wrapped = strWrap(line, contentWidth, {
            mode: 'softboundary',
            indent: leftPadding,
         });
         return wrapped.split('\n').map((part) => this.padLineWithBg(color + part, width, blockBg));
      }

      return [this.padLineWithBg(color + line, width, blockBg)];
   }

   private updateRenderedLines(): void {
      this.renderedLines = [];
      this.exitLines = [];
      const width = this.lastWidth;
      const reset = ncc();
      const baseBlockBg = colorMix(CATPPUCCIN_VPALETTE.mantle, CATPPUCCIN_VPALETTE.surface0, 0.2);

      if (this.options.preambleLines.length > 0) {
         for (const line of this.options.preambleLines) {
            this.renderedLines.push(...this.renderPreambleLine(line, width, baseBlockBg, 3));
            if (line.length === 0) this.exitLines.push('');
            else this.exitLines.push(`${fgRgb(CATPPUCCIN_VPALETTE.overlay1)}${line}${reset}`);
         }

         if (this.parsedDiffs.length > 0) {
            this.renderedLines.push(this.padLineWithBg(' ', width, baseBlockBg));
            this.exitLines.push('');
         }
      }

      for (let i = 0; i < this.parsedDiffs.length; i++) {
         const diff = this.parsedDiffs[i];
         const blockBg = baseBlockBg;

         if (i !== 0) {
            this.renderedLines.push(
               this.padLineWithBg(' ', width, blockBg),
               this.padLineWithBg(
                  '      ' + fgRgb(CATPPUCCIN_VPALETTE.surface0) + '─'.repeat(width - 12),
                  width,
                  blockBg
               ),
               this.padLineWithBg(' ', width, blockBg)
            );
         }
         this.renderedLines.push(this.renderFileName(diff.oldFileName, diff.newFileName, width));
         this.exitLines.push(`${fgRgb(CATPPUCCIN_VPALETTE.lavender)}${diff.newFileName}${reset}`);

         for (const line of diff.lines) {
            this.renderedLines.push(...this.renderLine(line, width, blockBg));
            if (line.type === 'add')
               this.exitLines.push(`${fgRgb(CATPPUCCIN_VPALETTE.green)}+ ${line.content}${reset}`);
            else if (line.type === 'delete')
               this.exitLines.push(`${fgRgb(CATPPUCCIN_VPALETTE.red)}- ${line.content}${reset}`);
            else if (line.type === 'context') this.exitLines.push(`  ${line.content}`);
            else if (line.type === 'hunk')
               this.exitLines.push(`${fgRgb(CATPPUCCIN_VPALETTE.cyan)}${line.content}${reset}`);
         }
      }
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
               : `${bgCode}${' '.repeat(width)}${ncc()}`
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

   const lines = diffText.split('\n');
   const firstDiffIndex = lines.findIndex((line) => DIFF_HEADER_LINE_REGEX.test(line));
   const preambleLines =
      firstDiffIndex > 0 ? lines.slice(0, firstDiffIndex) : firstDiffIndex === -1 ? lines : [];
   const diffBody =
      firstDiffIndex === -1 ? '' : lines.slice(Math.max(firstDiffIndex, 0)).join('\n');

   const spinnerCtrl =
      diffText.length > 10000
         ? spinner({
              message: 'Preparing diff viewer...',
              interval: 10,
           })
         : undefined;

   Logger.time('Preparing diff highlighting');
   const renderer = new DiffViewerRenderer(diffBody, { ...options, preambleLines });
   await renderer.prepareHighlighting();
   clearTerminalCache();
   renderer.onResize(getTerminalWidth(), getTerminalHeight());
   spinnerCtrl?.stop();
   Logger.timeEnd('Preparing diff highlighting', 'diff-viewer');

   return pagerWithRenderer(renderer, options);
}

/**
 * Simple check to see if the text looks like git diff output. Not foolproof but good enough for deciding when to use the diff viewer.
 */
export function isGitDiffOutput(text: string): boolean {
   return DIFF_HEADER_TEXT_REGEX.test(text);
}

export { parseDiffOutput };

function parseDiffHeader(
   line: string
): { fileName: string; oldFileName: string; newFileName: string; isCombined: boolean } | null {
   if (line.startsWith('diff --git ')) {
      const match = line.match(/diff --git a\/(.+?) b\/(.+)/);
      if (!match) return null;
      return {
         fileName: match[2],
         oldFileName: match[1],
         newFileName: match[2],
         isCombined: false,
      };
   }

   const combinedMatch = line.match(/^diff --(?:cc|combined) (.+)$/);
   if (!combinedMatch) return null;
   return {
      fileName: combinedMatch[1],
      oldFileName: combinedMatch[1],
      newFileName: combinedMatch[1],
      isCombined: true,
   };
}
