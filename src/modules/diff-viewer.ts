import { Err, estimateStrComplexity, ex_length, ncc, strWrap, yuString } from '@lib/Tools';
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
   PagerActionResult,
   PAGER_DEFAULT_OPTIONS,
} from './pager';
import { bgRgb, colorMix, fgRgb, inferAnsiStyles, RgbVec, serializeAnsiStyles } from './graphics';
import Logger from '@/utils/logger';
import { spinner } from './shell';
import { CATPPUCCIN_VPALETTE, INLINE_DIFF_MERGE_DISTANCE, TUI_THEME } from '@/consts';
import { DiffModule, ShikijsCliModule } from '@/common/types';

const STYLES = {
   bold: (str: string) => `\x1b[1m${str}\x1b[22m`,
   italic: (str: string) => `\x1b[3m${str}\x1b[23m`,
   underline: (str: string) => `\x1b[4m${str}\x1b[24m`,
   dim: (str: string) => `\x1b[2m${str}\x1b[22m`,
};

const DIFF_HEADER_LINE_REGEX = /^diff --(git|cc|combined)\b/;
const DIFF_HEADER_TEXT_REGEX = /^diff --(git|cc|combined)\b/m;
const ANSI_SGR_REGEX = /^\x1b\[[0-9;]*m/;

/** Options for the diff viewer */
export interface DiffViewerOptions extends PagerOptions {
   theme?: string;
   workingDir?: string;
   preambleLines?: string[];
}

interface DiffLine {
   type: 'add' | 'delete' | 'context' | 'header' | 'hunk' | 'file' | 'empty' | 'modify';
   content: string;
   oldLineNum?: number;
   newLineNum?: number;
   highlightedContent?: string;
   inlineSegments?: InlineDiffSegment[];
}

interface InlineDiffSegment {
   type: 'same' | 'add' | 'delete';
   value: string;
}

interface AnsiCharToken {
   prefix: string;
   char: string;
}

interface ParsedDiff {
   fileName: string;
   oldFileName: string;
   newFileName: string;
   lang: BundledLanguage;
   lines: DiffLine[];
}

export type BundledLanguage = Parameters<ShikijsCliModule['codeToANSI']>[1];
type DiffChange = {
   added?: boolean;
   removed?: boolean;
   value: string;
};
type DiffCharsFn = (oldStr: string, newStr: string) => DiffChange[];

let shikiPromise: Promise<ShikijsCliModule> | null = null;
let diffPromise: Promise<DiffModule> | null = null;

async function getShiki(): Promise<ShikijsCliModule> {
   shikiPromise ??= import('@shikijs/cli');
   return await shikiPromise;
}

async function getDiffLib(): Promise<DiffModule> {
   diffPromise ??= import('diff');
   return await diffPromise;
}

/**
 * Compacts adjacent inline diff segments that have the same type.
 * @param segments - Inline segments to normalize.
 * @returns Compacted inline segments.
 */
function compactInlineSegments(segments: InlineDiffSegment[]): InlineDiffSegment[] {
   const compacted: InlineDiffSegment[] = [];
   for (const segment of segments) {
      if (!segment.value) continue;
      const last = compacted[compacted.length - 1];
      if (last && last.type === segment.type) last.value += segment.value;
      else compacted.push({ ...segment });
   }
   return compacted;
}

/**
 * Returns true when a diff change represents modified content.
 * @param change - Diff change object.
 */
function isChangedSegment(change: DiffChange): boolean {
   return Boolean(change.added || change.removed);
}

/**
 * Returns true when a "same" segment should be merged into nearby changes.
 * This merges tiny unchanged gaps between two changed ranges.
 * @param changes - Character-level diff changes.
 * @param index - Segment index to check.
 * @param maxGap - Maximum gap length (exclusive).
 */
function shouldMergeGap(changes: DiffChange[], index: number, maxGap: number): boolean {
   const current = changes[index];
   if (!current || isChangedSegment(current)) return false;

   const chars = Array.from(current.value);
   const newlineCount = chars.filter((char) => char === '\n').length;
   if (newlineCount > 1) return false;
   const visibleGapLength = chars.filter((char) => char !== '\n' && char !== '\r').length;
   if (visibleGapLength >= maxGap) return false;

   let hasChangedBefore = false;
   for (let i = index - 1; i >= 0; i--) {
      if (!changes[i]?.value) continue;
      if (isChangedSegment(changes[i])) hasChangedBefore = true;
      break;
   }
   if (!hasChangedBefore) return false;

   let hasChangedAfter = false;
   for (let i = index + 1; i < changes.length; i++) {
      if (!changes[i]?.value) continue;
      if (isChangedSegment(changes[i])) hasChangedAfter = true;
      break;
   }

   return hasChangedAfter;
}

/**
 * Creates mixed inline segments that include unchanged, deleted, and added chunks.
 * Used for compact single-line replacement rendering.
 * @param changes - Character-level diff changes.
 * @returns Inline segments preserving both deleted and added chunks.
 */
function buildMergedInlineSegments(changes: DiffChange[]): InlineDiffSegment[] {
   const segments = changes.map((change, index) => {
      const type = change.removed
         ? ('delete' as const)
         : change.added || shouldMergeGap(changes, index, INLINE_DIFF_MERGE_DISTANCE)
            ? ('add' as const)
            : ('same' as const);
      return { type, value: change.value };
   });
   return compactInlineSegments(segments);
}

/**
 * Builds inline segments for a specific line kind from character-level changes.
 * - For added line: excludes removed chunks
 * - For deleted line: excludes added chunks
 * @param changes - Character-level diff changes.
 * @param lineType - Target line type.
 * @returns Inline segments for the target line.
 */
function buildLineInlineSegments(
   changes: DiffChange[],
   lineType: 'add' | 'delete'
): InlineDiffSegment[] {
   const segments: InlineDiffSegment[] = [];
   for (let index = 0; index < changes.length; index++) {
      const change = changes[index];
      if (lineType === 'add' && change.removed) continue;
      if (lineType === 'delete' && change.added) continue;

      if (change.added) segments.push({ type: 'add', value: change.value });
      else if (change.removed) segments.push({ type: 'delete', value: change.value });
      else if (shouldMergeGap(changes, index, INLINE_DIFF_MERGE_DISTANCE)) {
         segments.push({ type: lineType, value: change.value });
      } else {
         segments.push({ type: 'same', value: change.value });
      }
   }
   return compactInlineSegments(segments);
}

/**
 * Reconstructs plain text from inline segments for verification.
 * @param segments - Inline segments to convert.
 * @returns Plain reconstructed content.
 */
function inlineSegmentsToText(segments: InlineDiffSegment[]): string {
   return segments.map((segment) => segment.value).join('');
}

/**
 * Splits inline segments by line breaks into per-line segment arrays.
 * @param segments - Combined inline segments that may contain newlines.
 * @param lineCount - Expected number of output lines.
 * @returns Per-line inline segments.
 */
function splitInlineSegmentsByLines(
   segments: InlineDiffSegment[],
   lineCount: number
): InlineDiffSegment[][] {
   const result = Array.from({ length: lineCount }, () => [] as InlineDiffSegment[]);
   if (lineCount <= 0) return result;

   let lineIndex = 0;

   for (const segment of segments) {
      let remaining = segment.value;

      while (remaining.length > 0 && lineIndex < lineCount) {
         const newlineIndex = remaining.indexOf('\n');
         if (newlineIndex === -1) {
            if (remaining) result[lineIndex].push({ type: segment.type, value: remaining });
            break;
         }

         const beforeNewline = remaining.slice(0, newlineIndex);
         if (beforeNewline) result[lineIndex].push({ type: segment.type, value: beforeNewline });

         lineIndex++;
         remaining = remaining.slice(newlineIndex + 1);
      }
   }

   for (let i = 0; i < result.length; i++) {
      result[i] = compactInlineSegments(result[i]);
   }

   return result;
}

/**
 * Tokenizes ANSI text into visible characters with their immediate ANSI prefix.
 * @param text - ANSI text to tokenize.
 */
function tokenizeAnsiByChar(text: string): { tokens: AnsiCharToken[]; trailingAnsi: string } {
   const tokens: AnsiCharToken[] = [];
   let trailingAnsi = '';
   let i = 0;
   let pendingAnsi = '';

   while (i < text.length) {
      if (text[i] === '\x1b') {
         const sgrMatch = text.slice(i).match(ANSI_SGR_REGEX);
         if (sgrMatch) {
            pendingAnsi += sgrMatch[0];
            i += sgrMatch[0].length;
            continue;
         }
      }

      const codePoint = text.codePointAt(i);
      if (codePoint === undefined) break;
      const char = String.fromCodePoint(codePoint);
      tokens.push({ prefix: pendingAnsi, char });
      pendingAnsi = '';
      i += char.length;
   }

   trailingAnsi = pendingAnsi;
   return { tokens, trailingAnsi };
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
   let combinedPrefixLength = 2;

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
            combinedPrefixLength = 2;
         } else {
            currentDiff = null;
            isCombinedDiff = false;
            combinedPrefixLength = 2;
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
         isCombinedDiff = true;
         const parentMatches = line.match(/-\d+(?:,\d+)?/g);
         combinedPrefixLength = Math.max(parentMatches?.length ?? 2, 2);
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
         if (line.length >= combinedPrefixLength) {
            const prefix = line.slice(0, combinedPrefixLength);
            if (/^[ +-]+$/.test(prefix)) {
               const content = line.slice(combinedPrefixLength);
               const hasPlus = prefix.includes('+');
               const hasMinus = prefix.includes('-');
               const type: DiffLine['type'] = hasPlus ? 'add' : hasMinus ? 'delete' : 'context';
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
      (l) => l.type === 'add' || l.type === 'delete' || l.type === 'context' || l.type === 'modify'
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

         const hasUsableContext = isFileContextCompatible(newLines, fileContext);

         Logger.debug(
            `Highlighting diff for ${diff.newFileName} with ${codeLines.length} changed lines and ${fileContext.size} lines of context from FS`,
            'diff-viewer'
         );

         if (fileContext.size > 0 && hasUsableContext) {
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

function isFileContextCompatible(lines: DiffLine[], fileContext: Map<number, string>): boolean {
   if (fileContext.size === 0) return false;

   let checked = 0;

   for (const line of lines) {
      if (line.newLineNum === undefined) continue;
      const contextLine = fileContext.get(line.newLineNum);
      if (contextLine === undefined || contextLine !== line.content) return false;
      checked++;
   }

   return checked > 0;
}

export class DiffViewerRenderer implements PagerRenderer {
   private parsedDiffs: ParsedDiff[] = [];
   private renderedLines: string[] = [];
   private options: Required<DiffViewerOptions>;
   private lastWidth: number = 0;
   private lastHeight: number = 0;
   private redundancyLv: number = 0;
   private widthRedundancyLv: number = 0;
   private logger = new Logger('diff-renderer');

   /** Blended background colors for diff lines (translucent effect) */
   private readonly ADDED_BG = colorMix(CATPPUCCIN_VPALETTE.base, CATPPUCCIN_VPALETTE.green, 0.13);
   private readonly DELETED_BG = colorMix(CATPPUCCIN_VPALETTE.base, CATPPUCCIN_VPALETTE.red, 0.13);
   private readonly ADDED_INLINE_BG = colorMix(
      CATPPUCCIN_VPALETTE.base,
      CATPPUCCIN_VPALETTE.green,
      0.28
   );
   private readonly DELETED_INLINE_BG = colorMix(
      CATPPUCCIN_VPALETTE.base,
      CATPPUCCIN_VPALETTE.red,
      0.28
   );
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
      this.options = {
         ...PAGER_DEFAULT_OPTIONS,
         showLineNumbers: true,
         theme: TUI_THEME,
         lineNumberWidth: 5,
         wrapLines: true,
         showStatus: true,
         preambleLines: [],
         ...options,
      } as Required<DiffViewerOptions>;
      this.logger.debug('Initializing DiffViewerRenderer with options: ' + yuString(this.options));

      this.lastWidth = getTerminalWidth();
      this.lastHeight = getTerminalHeight();
      this.redundancyLv = options.redundancyLv ?? estimateStrComplexity(diffText);
      this.widthRedundancyLv = Math.max(0, this.redundancyLv);

      this.logger.debug(
         `Terminal size: ${this.lastWidth}x${this.lastHeight}, redundancy level: ${this.redundancyLv}`
      );
      this.parsedDiffs = this.logger.time('Parsing diff output', () => parseDiffOutput(diffText));
      this.updateRenderedLines();
   }

   async prepareHighlighting(): Promise<void> {
      await this.prepareInlineDiffs();

      for (const diff of this.parsedDiffs) {
         const codeLines = diff.lines.filter(
            (l) =>
               l.type === 'add' ||
               l.type === 'delete' ||
               l.type === 'context' ||
               l.type === 'modify'
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

   /**
    * Prepares character-level inline diff metadata.
    * - Collapses 1-to-1 replacements on the same line number into a single `modify` line.
    * - Keeps larger replacement blocks as separate add/delete lines with per-character highlights.
    */
   private async prepareInlineDiffs(): Promise<void> {
      const hasReplacementBlock = this.parsedDiffs.some((diff) => {
         for (let i = 0; i < diff.lines.length; i++) {
            if (diff.lines[i].type !== 'add' && diff.lines[i].type !== 'delete') continue;
            const blockStart = i;
            while (
               i < diff.lines.length &&
               (diff.lines[i].type === 'add' || diff.lines[i].type === 'delete')
            )
               i++;
            const block = diff.lines.slice(blockStart, i);
            const hasAdd = block.some((line) => line.type === 'add');
            const hasDelete = block.some((line) => line.type === 'delete');
            if (hasAdd && hasDelete) return true;
            i--;
         }
         return false;
      });

      if (!hasReplacementBlock) return;

      let diffChars: DiffCharsFn | undefined;
      try {
         const diffLib = await getDiffLib();
         diffChars = diffLib.diffChars;
      } catch (e) {
         this.logger.warn(`Inline diff module failed to load: ${Err.from(e)}`);
         return;
      }

      if (!diffChars) {
         this.logger.warn('Inline diff module loaded without diffChars export');
         return;
      }

      for (const diff of this.parsedDiffs) {
         let i = 0;
         while (i < diff.lines.length) {
            if (diff.lines[i].type !== 'add' && diff.lines[i].type !== 'delete') {
               i++;
               continue;
            }

            const blockStart = i;
            while (
               i < diff.lines.length &&
               (diff.lines[i].type === 'add' || diff.lines[i].type === 'delete')
            )
               i++;
            const blockEnd = i;
            const block = diff.lines.slice(blockStart, blockEnd);

            const deletedLines = block.filter((line) => line.type === 'delete');
            const addedLines = block.filter((line) => line.type === 'add');
            if (deletedLines.length === 0 || addedLines.length === 0) continue;

            const isSingleLineReplacement =
               deletedLines.length === 1 &&
               addedLines.length === 1 &&
               deletedLines[0].oldLineNum !== undefined &&
               addedLines[0].newLineNum !== undefined;

            if (isSingleLineReplacement) {
               const oldLine = deletedLines[0];
               const newLine = addedLines[0];
               const changes = diffChars(oldLine.content, newLine.content);
               const inlineSegments = buildMergedInlineSegments(changes);

               const modifyLine: DiffLine = {
                  type: 'modify',
                  content: newLine.content,
                  oldLineNum: oldLine.oldLineNum,
                  newLineNum: newLine.newLineNum,
                  inlineSegments,
               };

               diff.lines.splice(blockStart, blockEnd - blockStart, modifyLine);
               i = blockStart + 1;
               continue;
            }

            const deletedText = deletedLines.map((line) => line.content).join('\n');
            const addedText = addedLines.map((line) => line.content).join('\n');
            const changes = diffChars(deletedText, addedText);

            const addSegments = buildLineInlineSegments(changes, 'add');
            if (addSegments.length > 0 && inlineSegmentsToText(addSegments) === addedText) {
               const addLineSegments = splitInlineSegmentsByLines(addSegments, addedLines.length);
               for (let lineIndex = 0; lineIndex < addedLines.length; lineIndex++) {
                  if (addLineSegments[lineIndex].length > 0)
                     addedLines[lineIndex].inlineSegments = addLineSegments[lineIndex];
               }
            }

            const deleteSegments = buildLineInlineSegments(changes, 'delete');
            if (deleteSegments.length > 0 && inlineSegmentsToText(deleteSegments) === deletedText) {
               const deleteLineSegments = splitInlineSegmentsByLines(
                  deleteSegments,
                  deletedLines.length
               );
               for (let lineIndex = 0; lineIndex < deletedLines.length; lineIndex++) {
                  if (deleteLineSegments[lineIndex].length > 0)
                     deletedLines[lineIndex].inlineSegments = deleteLineSegments[lineIndex];
               }
            }
         }
      }
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
         case 'modify':
            sign = '~';
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

      const displayContent = line.inlineSegments
         ? this.renderInlineSegments(
            line.inlineSegments,
            line.type,
            bgCode,
            line.highlightedContent || line.content,
            line.content
         )
         : line.highlightedContent || line.content;
      const lineNum = line.newLineNum ?? line.oldLineNum;
      const lineNumStr =
         lineNum !== undefined ? String(lineNum).padStart(lineNumWidth) : ' '.repeat(lineNumWidth);
      const gutter = `${fgRgb(CATPPUCCIN_VPALETTE.overlay1)}${lineNumStr} ${fgRgb(signColor)}${sign} `;

      if (
         this.options.wrapLines &&
         ex_length(displayContent, this.widthRedundancyLv) > contentWidth
      ) {
         const wrapped = strWrap(displayContent, contentWidth, {
            mode: 'softboundary',
            redundancyLv: this.widthRedundancyLv,
         });

         if (wrapped.length < 2) {
            Logger.warn(
               `Expected wrapped content to have multiple lines but got: "${wrapped}". Original content length: ${displayContent.length}, wrapped length: ${wrapped.length}, content width: ${contentWidth}`,
               'diff-renderer'
            );
         }

         const splitted = wrapped.split('\n');
         let lastStyles;
         for (let i = 0; i < splitted.length; i++) {
            const g = i === 0 ? gutter : ' '.repeat(lineNumWidth + 3);

            if (lastStyles) splitted[i] = serializeAnsiStyles(lastStyles) + splitted[i];
            results.push(this.padLineWithBg(g + bgRgb(bgCode) + splitted[i], width, gutterBgCode));
            if (i !== splitted.length - 1) lastStyles = inferAnsiStyles(splitted[i]);
         }
      } else {
         results.push(
            this.padLineWithBg(gutter + bgRgb(bgCode) + displayContent, width, gutterBgCode)
         );
      }
      return results;
   }

   private renderInlineSegments(
      segments: InlineDiffSegment[],
      lineType: DiffLine['type'],
      lineBg: RgbVec,
      highlightedSource: string,
      plainSource: string
   ): string {
      const out: string[] = [];
      const lineBgAnsi = bgRgb(lineBg);

      const { tokens, trailingAnsi } = tokenizeAnsiByChar(highlightedSource);
      const plainChars = Array.from(plainSource);

      let tokenCursor = 0;

      const consumeStyledChunk = (chunk: string): string => {
         const chunkChars = Array.from(chunk);
         let chunkOut = '';
         for (const chunkChar of chunkChars) {
            const token = tokens[tokenCursor];
            if (token) {
               chunkOut += `${token.prefix}${token.char}`;
               tokenCursor++;
               continue;
            }

            const fallbackChar = plainChars[tokenCursor] ?? chunkChar;
            chunkOut += fallbackChar;
            tokenCursor++;
         }
         return chunkOut;
      };

      for (const segment of segments) {
         if (segment.type === 'same') {
            out.push(consumeStyledChunk(segment.value));
            continue;
         }

         if (segment.type === 'add') {
            out.push(
               `${bgRgb(this.ADDED_INLINE_BG)}${consumeStyledChunk(segment.value)}${lineBgAnsi}`
            );
            continue;
         }

         const deletedChunk =
            lineType === 'modify' ? segment.value : consumeStyledChunk(segment.value);

         const shouldStrike = lineType === 'modify';
         const strikeStart = shouldStrike ? '\x1b[9m' : '';
         const strikeEnd = shouldStrike ? '\x1b[29m' : '';
         out.push(
            `${bgRgb(this.DELETED_INLINE_BG)}${strikeStart}${deletedChunk}${strikeEnd}${lineBgAnsi}`
         );
      }

      // keep any dangling ansi state emitted by highlighter
      if (trailingAnsi) out.push(trailingAnsi);

      return out.join('');
   }

   private padLineWithBg(str: string, width: number, bgColor: RgbVec): string {
      const padding = Math.max(0, width - ex_length(str, this.widthRedundancyLv));
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

      if (this.options.wrapLines && ex_length(line, this.widthRedundancyLv) > contentWidth) {
         const wrapped = strWrap(line, contentWidth, {
            mode: 'softboundary',
            indent: leftPadding,
            redundancyLv: this.widthRedundancyLv,
         });
         return wrapped.split('\n').map((part) => this.padLineWithBg(color + part, width, blockBg));
      }

      return [this.padLineWithBg(color + line, width, blockBg)];
   }

   private updateRenderedLines(): void {
      this.renderedLines = [];
      const width = this.lastWidth;
      const baseBlockBg = colorMix(CATPPUCCIN_VPALETTE.mantle, CATPPUCCIN_VPALETTE.surface0, 0.2);

      if (this.options.preambleLines.length > 0) {
         for (const line of this.options.preambleLines) {
            this.renderedLines.push(...this.renderPreambleLine(line, width, baseBlockBg, 3));
         }

         if (this.parsedDiffs.length > 0) {
            this.renderedLines.push(this.padLineWithBg(' ', width, baseBlockBg));
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

         for (const line of diff.lines) {
            this.renderedLines.push(...this.renderLine(line, width, blockBg));
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
}

export async function viewDiff(
   diffText: string,
   options: DiffViewerOptions = {}
): Promise<PagerActionResult | void> {
   if (!canUseDiffViewer()) {
      Logger.warn(
         'Diff viewer is not supported in this environment. Falling back to plain output.',
         'diff-viewer'
      );
      return pager(diffText, { ...options, showLineNumbers: false });
   }

   const spinnerCtrl =
      diffText.length > 10000
         ? spinner({
            message: 'Preparing diff viewer...',
            interval: 10,
         })
         : undefined;

   const { body: diffBody, preamble: preambleLines } = separatePreamble(diffText);

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

function separatePreamble(diffText: string): { body: string; preamble: string[] } {
   const lines = diffText.split('\n');
   const firstDiffIndex = lines.findIndex((line) => DIFF_HEADER_LINE_REGEX.test(line));
   if (firstDiffIndex === -1) return { body: diffText, preamble: [] };
   return {
      body: lines.slice(firstDiffIndex).join('\n'),
      preamble: lines.slice(0, firstDiffIndex),
   };
}
