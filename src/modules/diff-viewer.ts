import path from 'path';
import * as fs from './fs';
import type { ChangeObject } from 'diff';

import {
   Err,
   estimateStrComplexity,
   ex_length,
   strLimit,
   strSlice,
   strWrap,
   yuString,
   CheckCache,
} from '@lib/Tools';

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
import { $, spinner, SpinnerController } from './shell';
import {
   CATPPUCCIN_VPALETTE,
   INLINE_DIFF_SEGMENT_LENGTH_SPLIT_THRESH,
   INLINE_DIFF_MERGE_DISTANCE,
   INLINE_DIFF_SEQUENCE_LENGTH_SPLIT_THRESH,
   TUI_THEME,
   DIFF_HEADER_LINE_REGEX,
   ANSI_SGR_REGEX,
   DIFF_HEADER_TEXT_REGEX,
   SGR,
} from '@/consts';
import { DiffModule, GdxContext, ShikijsCliModule } from '@/common/types';
import { quickPrint } from '@/utils/utilities';
import { getConfig } from '@/common/config';
import { getCache } from '@/common/cache';
import Threaded from '@/modules/threaded';
import global from '@/global';
import { getGenericWorkerUrl } from '@/cli/worker';
import { revParseCached } from './git';
import { getLanguageCatalog, resolveShikiLanguageIdForPath } from './languages';

const STYLES = {
   bold: (str: string) => `\x1b[1m${str}\x1b[22m`,
   italic: (str: string) => `\x1b[3m${str}\x1b[23m`,
   underline: (str: string) => `\x1b[4m${str}\x1b[24m`,
   dim: (str: string) => `\x1b[2m${str}\x1b[22m`,
};

function normalizeDiffLineEndings(diffText: string): string {
   return diffText.replace(/\r/g, '');
}

/** Options for the diff viewer */
export interface DiffViewerOptions extends PagerOptions {
   theme?: string;
   workingDir?: string;
   preambleLines?: string[];
   disableSyntaxHighlighting?: boolean;
   git$?: GdxContext['git$'];
   highlighting?: DiffHighlightingOptions;
}

interface DiffHighlightingOptions {
   fullfileHighlight?: boolean;
   maxHunkSize?: number;
   oldRevision?: string;
   newRevision?: string;
}

interface UnifiedPatchHunk {
   oldStart: number;
   oldLines: number;
   newStart: number;
   newLines: number;
   lines: string[];
   heading?: string;
}

interface UnifiedPatchResult {
   hunks: UnifiedPatchHunk[];
}

type StructuredPatchFn = (
   oldFileName: string,
   newFileName: string,
   oldStr: string,
   newStr: string,
   oldHeader?: string,
   newHeader?: string,
   options?: { context?: number }
) => UnifiedPatchResult;

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

interface HighlightedFullFileCacheEntry {
   contentLength: number;
   highlightedLines?: string[];
}

type FullFileHighlightResult = 'highlighted' | 'unavailable' | 'limited';

export const WORKING_TREE_REVISION = '__GDX_WORKING_TREE__';
export const INDEX_REVISION = '__GDX_INDEX__';

interface ParsedDiff {
   fileName: string;
   oldFileName: string;
   newFileName: string;
   lang: string;
   lines: DiffLine[];
}

export type BundledLanguage = Parameters<ShikijsCliModule['codeToANSI']>[1];

declare const shikiWorker: ShikijsCliModule;

let shikiPromise: Promise<ShikijsCliModule> | null = null;
let diffPromise: Promise<DiffModule> | null = null;
let highlightThreaded: Threaded | null = null;
const logger = new Logger('diff-viewer');

async function getShiki(): Promise<ShikijsCliModule> {
   shikiPromise ??= import('@shikijs/cli');
   return await shikiPromise;
}

async function getDiffLib(): Promise<DiffModule> {
   diffPromise ??= import('diff');
   return await diffPromise;
}

/**
 * Gets the worker pool used for full-file syntax highlighting.
 * @returns Shared syntax-highlighting worker pool.
 */
function getHighlightThreaded(): Threaded {
   const workerSource = getGenericWorkerUrl();
   if (!workerSource) throw new Error('Generic worker file is not available.');

   highlightThreaded ??= new Threaded({
      env: { FORCE_COLOR: process.env.FORCE_COLOR || '3' },
      semaphore: global.threadResources,
      workerSource,
   }).require('@shikijs/cli', 'shikiWorker');
   return highlightThreaded;
}

/**
 * Returns true when the generic worker file is available.
 */
function canUseShikiHighlightWorker(): boolean {
   return getGenericWorkerUrl() !== null;
}

/**
 * Defragments adjacent inline diff segments that have the same type.
 * @param segments - Inline segments to normalize.
 * @returns Defragmented inline segments.
 */
function defragInlineSegments(segments: InlineDiffSegment[]): InlineDiffSegment[] {
   const defraged: InlineDiffSegment[] = [];
   for (const segment of segments) {
      if (!segment.value) continue;
      const last = defraged[defraged.length - 1];
      if (last && last.type === segment.type) last.value += segment.value;
      else defraged.push({ ...segment });
   }
   return defraged;
}

/**
 * Returns true when a diff change represents modified content.
 * @param change - Diff change object.
 */
function isChangedSegment(change: ChangeObject<string>): boolean {
   return Boolean(change.added || change.removed);
}

/**
 * Returns true when a "same" segment should be merged into nearby changes.
 * This merges tiny unchanged gaps between two changed ranges.
 * @param changes - Character-level diff changes.
 * @param index - Segment index to check.
 * @param maxGap - Maximum gap length (exclusive).
 */
function shouldMergeGap(changes: ChangeObject<string>[], index: number, maxGap: number): boolean {
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
 *
 * Also merges tiny unchanged regions in segments to "unchanged" segments to simulate character-level diff.
 *
 * @param changes - Word-level diff changes.
 * @returns Inline segments preserving both deleted and added chunks.
 */
function buildMergedInlineSegments(changes: ChangeObject<string>[]): InlineDiffSegment[] {
   const segments: InlineDiffSegment[] = [];
   let lastSegment: string | null = null;

   for (let i = 0; i < changes.length; i++) {
      const change = changes[i];
      const length = change.value.length;

      if (change.removed) {
         if (lastSegment && lastSegment.length < length) {
            if (change.value.startsWith(lastSegment)) {
               segments.splice(
                  i - 1,
                  1,
                  {
                     type: 'same',
                     value: lastSegment,
                  },
                  {
                     type: 'delete',
                     value: change.value.slice(lastSegment.length),
                  }
               );
               continue;
            } else if (change.value.endsWith(lastSegment)) {
               segments.splice(
                  i - 1,
                  1,
                  {
                     type: 'delete',
                     value: change.value.slice(0, length - lastSegment.length),
                  },
                  {
                     type: 'same',
                     value: lastSegment,
                  }
               );
               continue;
            }
         } else if (lastSegment && lastSegment.length > length) {
            if (lastSegment.startsWith(change.value)) {
               segments.splice(
                  i - 1,
                  1,
                  {
                     type: 'same',
                     value: change.value,
                  },
                  {
                     type: 'add',
                     value: lastSegment.slice(length),
                  }
               );
               continue;
            } else if (lastSegment.endsWith(change.value)) {
               segments.splice(
                  i - 1,
                  1,
                  {
                     type: 'add',
                     value: lastSegment.slice(0, lastSegment.length - length),
                  },
                  {
                     type: 'same',
                     value: change.value,
                  }
               );
               continue;
            }
         }
         lastSegment = change.value;
         segments.push({ type: 'delete', value: change.value });
         continue;
      }
      if (change.added) {
         if (lastSegment && lastSegment.length < length) {
            if (change.value.startsWith(lastSegment)) {
               segments.splice(
                  i - 1,
                  1,
                  {
                     type: 'same',
                     value: lastSegment,
                  },
                  {
                     type: 'add',
                     value: change.value.slice(lastSegment.length),
                  }
               );
               continue;
            } else if (change.value.endsWith(lastSegment)) {
               segments.splice(
                  i - 1,
                  1,
                  {
                     type: 'add',
                     value: change.value.slice(0, length - lastSegment.length),
                  },
                  {
                     type: 'same',
                     value: lastSegment,
                  }
               );
               continue;
            }
         } else if (lastSegment && lastSegment.length > length) {
            if (lastSegment.startsWith(change.value)) {
               segments.splice(
                  i - 1,
                  1,
                  {
                     type: 'same',
                     value: change.value,
                  },
                  {
                     type: 'delete',
                     value: lastSegment.slice(length),
                  }
               );
               continue;
            } else if (lastSegment.endsWith(change.value)) {
               segments.splice(
                  i - 1,
                  1,
                  {
                     type: 'delete',
                     value: lastSegment.slice(0, lastSegment.length - length),
                  },
                  {
                     type: 'same',
                     value: change.value,
                  }
               );
               continue;
            }
         }
         lastSegment = change.value;
         segments.push({ type: 'add', value: change.value });
         continue;
      }
      segments.push({ type: 'same', value: change.value });
   }
   return defragInlineSegments(segments);
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
   changes: ChangeObject<string>[],
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
   return defragInlineSegments(segments);
}

/**
 * Determines whether to display inline segments in a compact merged form or separate added/deleted form.
 * If there are long unchanged segments between changes, it opts for separate form to avoid confusion.
 *
 * @param singleLineChanges - Character-level diff changes for a single line.
 * @return True to display in separate form, false to display in merged form.
 */
function shouldDisplayMultiline(singleLineChanges: ChangeObject<string>[]): boolean {
   let sequenceLength = 0;
   for (const diff of singleLineChanges) {
      if (sequenceLength > INLINE_DIFF_SEQUENCE_LENGTH_SPLIT_THRESH) return true;

      if (diff.count > INLINE_DIFF_SEGMENT_LENGTH_SPLIT_THRESH) {
         sequenceLength = 0;
         continue;
      }

      if (diff.added) {
         sequenceLength++;
      } else if (diff.removed) {
         sequenceLength++;
      }
   }

   return sequenceLength > INLINE_DIFF_SEQUENCE_LENGTH_SPLIT_THRESH;
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
      result[i] = defragInlineSegments(result[i]);
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

function formatUnifiedRange(start: number, count: number): string {
   if (count === 1) return String(start);
   return `${start},${count}`;
}

function colorizeUnifiedPatchLine(line: string): string {
   if (CheckCache.supportsColor <= 0) return line;

   if (line.startsWith('@@')) return `${SGR.cyan}${line}${SGR.reset}`;
   if (line.startsWith('+')) return `${SGR.green}${line}${SGR.reset}`;
   if (line.startsWith('-')) return `${SGR.red}${line}${SGR.reset}`;
   if (line.startsWith('\\')) return `${SGR.dim}${line}${SGR.reset}`;
   return line;
}

async function buildCommitMessagePatch(
   oldText: string,
   newText: string
): Promise<{
   patchBodyLines: string[];
   rendererDiffText: string;
}> {
   const diffLib = await getDiffLib();
   const structuredPatch = diffLib.structuredPatch as StructuredPatchFn | undefined;

   if (!structuredPatch) {
      throw new Err(
         'Diff module does not provide structuredPatch.',
         'DIFF_STRUCTURED_PATCH_UNAVAILABLE'
      );
   }

   const patch = structuredPatch('a/COMMIT_EDITMSG', 'b/COMMIT_EDITMSG', oldText, newText, '', '', {
      context: 3,
   });

   const patchBodyLines: string[] = [];
   for (const hunk of patch.hunks || []) {
      const oldRange = formatUnifiedRange(hunk.oldStart, hunk.oldLines);
      const newRange = formatUnifiedRange(hunk.newStart, hunk.newLines);
      const heading = hunk.heading ? ` ${hunk.heading}` : '';
      patchBodyLines.push(`@@ -${oldRange} +${newRange} @@${heading}`);
      patchBodyLines.push(...hunk.lines);
   }

   const rendererDiffText =
      patchBodyLines.length > 0
         ? `diff --git a/COMMIT_EDITMSG b/COMMIT_EDITMSG\n${patchBodyLines.join('\n')}`
         : 'diff --git a/COMMIT_EDITMSG b/COMMIT_EDITMSG';

   return { patchBodyLines, rendererDiffText };
}

/**
 * Renders a plain-text unified diff between two commit messages.
 * Falls back to patch-style colored lines and upgrades to DiffViewerRenderer output
 * when the terminal supports TTY truecolor rendering.
 */
export async function renderCommitMessageDiffLines(
   oldText: string,
   newText: string
): Promise<string[]> {
   if (oldText === newText) return [];

   const { patchBodyLines, rendererDiffText } = await buildCommitMessagePatch(oldText, newText);
   if (patchBodyLines.length === 0) return [];

   if (canUseDiffViewer()) {
      const renderer = new DiffViewerRenderer(rendererDiffText, {
         showLineNumbers: false,
         showStatus: false,
         disableSyntaxHighlighting: true,
      });
      await renderer.prepareHighlighting();

      const renderedLines: string[] = [];
      for (let i = 0; i < renderer.getLineCount(); i++) renderedLines.push(renderer.getLine(i));
      return renderedLines;
   }

   return patchBodyLines.map((line) => colorizeUnifiedPatchLine(line));
}

/**
 * Prints a plain-text unified diff between two commit messages.
 */
export async function printCommitMessageDiff(oldText: string, newText: string): Promise<void> {
   const renderedLines = await renderCommitMessageDiffLines(oldText, newText);
   for (const line of renderedLines) quickPrint(line);
}

/**
 * Parses unified diff text into structured data with file info and line-level changes.
 * Designed to handle standard git diff formats, including combined diffs with multiple parents.
 *
 * @param diffText - Raw unified diff text to parse.
 * @return Parsed diff data with file names, language, and line-level change info.
 */
export function parseDiffOutput(diffText: string): ParsedDiff[] {
   const results: ParsedDiff[] = [];
   const lines = normalizeDiffLineEndings(diffText).split('\n');
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
               lang: 'plaintext',
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

async function highlightDiffWithContext(
   diff: ParsedDiff,
   theme: string,
   highlighting: Required<DiffHighlightingOptions>,
   git$?: GdxContext['git$'],
   spinnerCtrl?: SpinnerController,
): Promise<Map<DiffLine, string>> {
   const result = new Map<DiffLine, string>();
   const codeLines = diff.lines.filter(
      (l) => l.type === 'add' || l.type === 'delete' || l.type === 'context' || l.type === 'modify'
   );
   if (codeLines.length === 0) return result;

   const newLines = codeLines.filter((line) => line.type !== 'delete');
   const oldLines = codeLines.filter((line) => !(line.type === 'add' || line.type === 'modify'));

   try {
      const shiki = await getShiki();
      if (highlighting.fullfileHighlight && git$) {
         const fullFileResults = await Promise.all([
            highlightFullFileSide({
               git$,
               diff,
               lines: newLines,
               lineNumberKey: 'newLineNum',
               path: diff.newFileName,
               revision: highlighting.newRevision,
               maxHunkSize: highlighting.maxHunkSize,
               theme,
               shiki,
               result,
            }, spinnerCtrl),
            highlightFullFileSide({
               git$,
               diff,
               lines: oldLines,
               lineNumberKey: 'oldLineNum',
               path: diff.oldFileName,
               revision: highlighting.oldRevision,
               maxHunkSize: highlighting.maxHunkSize,
               theme,
               shiki,
               result,
            }, spinnerCtrl),
         ]);

         if (fullFileResults.includes('limited')) {
            logger.debug(
               `Full-file syntax highlighting was skipped for ${diff.newFileName} due to file size. Falling back to context-only highlighting.`
            );
            result.clear();
            await highlightDiffContextLines({ diff, theme, shiki, newLines, oldLines, result });
         }

         return result;
      }

      logger.debug(
         `Full-file syntax highlighting is ${highlighting.fullfileHighlight ? 'unavailable' : 'disabled'} for ${diff.newFileName}. Falling back to context-only highlighting.`
      );
      await highlightDiffContextLines({ diff, theme, shiki, newLines, oldLines, result });
   } catch (e) {
      logger.error(
         `Error highlighting diff for ${diff.newFileName}: ${Err.from(e)}`,
      );
      codeLines.forEach((line) => result.set(line, line.content));
   }
   return result;
}

/**
 * Highlights only the lines present in the parsed diff.
 * @param options - Diff context lines and highlighter dependencies.
 */
async function highlightDiffContextLines(options: {
   diff: ParsedDiff;
   theme: string;
   shiki: ShikijsCliModule;
   newLines: DiffLine[];
   oldLines: DiffLine[];
   result: Map<DiffLine, string>;
}): Promise<void> {
   const { diff, theme, shiki, newLines, oldLines, result } = options;

   if (newLines.length > 0) {
      const code = newLines.map((line) => line.content).join('\n');
      const highlighted = await shiki.codeToANSI(code, diff.lang as never, theme as never);
      const highlightedLines = highlighted.split('\n');
      for (let i = 0; i < newLines.length; i++) {
         if (highlightedLines[i]) result.set(newLines[i], highlightedLines[i]);
      }
   }

   if (oldLines.length > 0) {
      const code = oldLines.map((line) => line.content).join('\n');
      const highlighted = await shiki.codeToANSI(code, diff.lang as never, theme as never);
      const highlightedLines = highlighted.split('\n');
      for (let i = 0; i < oldLines.length; i++) {
         if (highlightedLines[i]) result.set(oldLines[i], highlightedLines[i]);
      }
   }
}

/**
 * Highlights diff lines by looking them up in syntax-highlighted full-file content.
 * @param options - Full-file lookup and highlighter dependencies.
 * @returns Whether the side was highlighted, unavailable, or over the size limit.
 */
async function highlightFullFileSide(
   options: {
      git$: GdxContext['git$'];
      diff: ParsedDiff;
      lines: DiffLine[];
      lineNumberKey: 'oldLineNum' | 'newLineNum';
      path: string;
      revision: string;
      maxHunkSize: number;
      theme: string;
      shiki: ShikijsCliModule;
      result: Map<DiffLine, string>;
   },
   spinnerCtrl?: SpinnerController
): Promise<FullFileHighlightResult> {
   const { git$, diff, lines, lineNumberKey, path, revision, maxHunkSize, theme, shiki, result } =
      options;
   if (lines.length === 0) return 'unavailable';

   const highlightedFile = await getHighlightedFullFileLines({
      git$,
      path,
      revision,
      lang: diff.lang,
      theme,
      maxHunkSize,
      shiki,
   });
   spinnerCtrl?.updateProgress(1);
   if (!highlightedFile) return 'unavailable';

   if (highlightedFile.contentLength > maxHunkSize) {
      logger.debug(
         `Skipping syntax highlighting for ${revision}:${path}; file size exceeds ${maxHunkSize} chars limit.`,
      );
      return 'limited';
   }

   for (const line of lines) {
      const lineNum = line[lineNumberKey];
      if (lineNum === undefined) continue;
      const highlightedLine = highlightedFile.highlightedLines?.[lineNum - 1];
      if (highlightedLine !== undefined) result.set(line, highlightedLine);
   }

   return 'highlighted';
}

async function getHighlightedFullFileLines(options: {
   git$: GdxContext['git$'];
   path: string;
   revision: string;
   lang: string;
   theme: string;
   maxHunkSize: number;
   shiki: ShikijsCliModule;
}): Promise<HighlightedFullFileCacheEntry | null> {
   const { git$, path, revision, lang, theme, maxHunkSize, shiki } = options;
   const readsWorkingTree = revision === WORKING_TREE_REVISION;
   const readsIndex = revision === INDEX_REVISION;
   const cache = await getCache();
   const cacheKey = [
      'diffViewer',
      'highlightedFullFile',
      'ansiV2',
      Array.isArray(git$) && git$[1] ? encodeCacheKeyPart(git$[1]) : 'd',
      encodeCacheKeyPart(revision),
      encodeCacheKeyPart(path),
      encodeCacheKeyPart(theme),
   ].join('.');
   const cached = readsWorkingTree || readsIndex
      ? null
      : await cache.getOneOff<HighlightedFullFileCacheEntry>(cacheKey);
   if (cached) return cached;

   let content: string;
   try {
      if (readsWorkingTree) {
         content = await getWorkingTreeFileContent(git$, path);
      } else if (readsIndex) {
         content = (await $`${git$} show ${`:${path}`}`).stdout;
      } else {
         content = (await $`${git$} show ${`${revision}:${path}`}`).stdout;
      }
   } catch {
      return null;
   }

   if (content.length > maxHunkSize) {
      const entry = {
         contentLength: content.length,
      } satisfies HighlightedFullFileCacheEntry;
      if (!readsWorkingTree && !readsIndex) await cache.setOneOff(cacheKey, entry);
      return entry;
   }

   const highlighted = canUseShikiHighlightWorker()
      ? await highlightFullFileAnsiInWorker(content, lang, theme, shiki)
      : await shiki.codeToANSI(content, lang as never, theme as never);

   const entry = {
      contentLength: content.length,
      highlightedLines: highlighted.split('\n'),
   } satisfies HighlightedFullFileCacheEntry;
   if (!readsWorkingTree && !readsIndex) await cache.setOneOff(cacheKey, entry);
   return entry;
}

/**
 * Reads a diff path from the current working tree for full-file highlighting.
 * @param git$ - Git executable context used to locate the repository root.
 * @param filePath - Repository-relative path from the diff header.
 * @returns The UTF-8 file content from the working tree.
 */
async function getWorkingTreeFileContent(git$: GdxContext['git$'], filePath: string): Promise<string> {
   const repoRoot = (await revParseCached(git$, ['--show-toplevel'])).trim();
   const absolutePath = path.resolve(repoRoot, filePath);
   const relativePath = path.relative(repoRoot, absolutePath);

   if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new Error(`Diff path escapes repository root: ${filePath}`);
   }

   return await fs.readFile(absolutePath, 'utf-8');
}

/**
 * Highlights a full file in a worker thread.
 * @param content - Full source text to highlight.
 * @param lang - Shiki bundled language identifier.
 * @param theme - Shiki theme identifier.
 * @param shiki - Main-thread Shiki module used for tests and fallback.
 * @returns ANSI-highlighted source text.
 */
async function highlightFullFileAnsiInWorker(
   content: string,
   lang: string,
   theme: string,
   shiki: ShikijsCliModule
): Promise<string> {
   if (process.env.NODE_ENV === 'test') {
      return await shiki.codeToANSI(content, lang as never, theme as never);
   }

   try {
      return await getHighlightThreaded()
         .spawn<string, [string, string, string]>(
            async (source, language, selectedTheme) =>
               await shikiWorker.codeToANSI(source, language as never, selectedTheme as never),
            [content, lang, theme]
         );
   } catch (error) {
      logger.debug(
         `Worker syntax highlighting failed; falling back to main thread: ${Err.from(error)}`,
      );
      return await shiki.codeToANSI(content, lang as never, theme as never);
   }
}

function encodeCacheKeyPart(value: string): string {
   return Buffer.from(value).toString('base64url');
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
      diffText = normalizeDiffLineEndings(diffText);
      this.options = {
         ...PAGER_DEFAULT_OPTIONS,
         showLineNumbers: true,
         theme: TUI_THEME,
         lineNumberWidth: 5,
         wrapLines: true,
         showStatus: true,
         preambleLines: [],
         disableSyntaxHighlighting: false,
         git$: undefined,
         highlighting: {
            fullfileHighlight: true,
            maxHunkSize: 200000,
            oldRevision: 'HEAD^',
            newRevision: 'HEAD',
            ...options.highlighting,
         },
         ...options,
      } as Required<DiffViewerOptions>;
      this.options.highlighting = {
         fullfileHighlight: true,
         maxHunkSize: 200000,
         oldRevision: 'HEAD^',
         newRevision: 'HEAD',
         ...this.options.highlighting,
      };
      this.logger.debug('Initializing DiffViewerRenderer with options: ' + yuString(this.options));

      this.lastWidth = getTerminalWidth();
      this.lastHeight = getTerminalHeight();
      this.redundancyLv =
         options.redundancyLv ??
         estimateStrComplexity(this.options.preambleLines.join('') + diffText);
      this.widthRedundancyLv = Math.max(0, this.redundancyLv);

      this.logger.debug(
         `Terminal size: ${this.lastWidth}x${this.lastHeight}, redundancy level: ${this.redundancyLv}, width redundancy level: ${this.widthRedundancyLv}`
      );
      this.parsedDiffs = this.logger.time('Parsing diff output', () => parseDiffOutput(diffText));
      this.updateRenderedLines();
   }

   async prepareHighlighting(spinnerCtrl?: SpinnerController): Promise<void> {
      await logger.time('Preparing inline diffs', () => this.prepareInlineDiffs());

      if (this.options.disableSyntaxHighlighting) {
         logger.time('Post-processing', () => this.updateRenderedLines());
         return;
      }

      if (this.options.highlighting.fullfileHighlight && !canUseShikiHighlightWorker()) {
         logger.debug(
            'Worker threads are not available in this environment. All syntax highlighting will run on the main thread, which may cause UI freezes for large diffs.',
         );
      }

      const languageCatalog = await getLanguageCatalog(
         spinnerCtrl ? { spinner: spinnerCtrl } : undefined
      );
      await Promise.all(
         this.parsedDiffs.map(async (diff) => {
            diff.lang = await resolveShikiLanguageIdForPath(diff.fileName, languageCatalog);
         })
      );

      const highlightPromises: Promise<void>[] = [];
      for (const diff of this.parsedDiffs) {
         const codeLines = diff.lines.filter(
            (l) =>
               l.type === 'add' ||
               l.type === 'delete' ||
               l.type === 'context' ||
               l.type === 'modify'
         );
         if (codeLines.length === 0) continue;
         const prom = highlightDiffWithContext(
            diff,
            this.options.theme,
            this.options.highlighting as Required<DiffHighlightingOptions>,
            this.options.git$,
            spinnerCtrl
         ).then((highlightedMap) => {
            codeLines.forEach((line) => {
               const highlighted = highlightedMap.get(line);
               if (highlighted !== undefined) line.highlightedContent = highlighted;
            });
         });
         highlightPromises.push(prom);
      }

      if (this.options.highlighting.fullfileHighlight && spinnerCtrl) {
         spinnerCtrl.options.progress = {
            current: 0,
            total: highlightPromises.length * 2, // Two sides per diff
         };
      }

      spinnerCtrl?.setMessage('Highlighting diffs');
      await Promise.all(highlightPromises);
      logger.time(
         'Post-processing after highlighting',
         () => this.updateRenderedLines(),
      );
      // fs.writeFileSync('parsed-diffs-debug.json', JSON.stringify(this.parsedDiffs.map(l =>
      //    l.lines
      //       .filter(l => l.highlightedContent !== undefined)
      //       .map(l => l.highlightedContent)
      // ), null, 2),
      //    'utf-8'
      // );
      // fs.writeFileSync('diff-rendered-debug.json', JSON.stringify(this.renderedLines, null, 2), 'utf-8');
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

      let diffChars: DiffModule['diffChars'] | undefined;
      let diffWordsWithSpace: DiffModule['diffWordsWithSpace'] | undefined;
      try {
         const diffLib = await getDiffLib();
         diffChars = diffLib.diffChars;
         diffWordsWithSpace = diffLib.diffWordsWithSpace;
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

            let deletedText: string;
            let addedText: string;
            let changes: ChangeObject<string>[] | null = null;
            if (isSingleLineReplacement) {
               const oldLine = deletedLines[0];
               const newLine = addedLines[0];
               changes = diffWordsWithSpace(oldLine.content, newLine.content);
               const inlineSegments = buildMergedInlineSegments(changes);
               deletedText = oldLine.content;
               addedText = newLine.content;

               if (!shouldDisplayMultiline(changes)) {
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
            }

            if (!changes) {
               deletedText = deletedLines.map((line) => line.content).join('\n');
               addedText = addedLines.map((line) => line.content).join('\n');
               changes = diffChars(deletedText, addedText);
            }

            const addSegments = buildLineInlineSegments(changes, 'add');
            if (addSegments.length > 0 && inlineSegmentsToText(addSegments) === addedText!) {
               const addLineSegments = splitInlineSegmentsByLines(addSegments, addedLines.length);
               for (let lineIndex = 0; lineIndex < addedLines.length; lineIndex++) {
                  if (addLineSegments[lineIndex].length > 0)
                     addedLines[lineIndex].inlineSegments = addLineSegments[lineIndex];
               }
            }

            const deleteSegments = buildLineInlineSegments(changes, 'delete');
            if (
               deleteSegments.length > 0 &&
               inlineSegmentsToText(deleteSegments) === deletedText!
            ) {
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
      const rendered: string[] = [];
      const lineNumWidth = this.options.lineNumberWidth;
      const gutterWidth = this.options.showLineNumbers ? lineNumWidth + 3 : 0;
      const contentWidth = width - gutterWidth;

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
            rendered.push(this.renderHunkHeader(line.content, width, contentWidth));
            return rendered;
         case 'header':
            rendered.push(this.renderFileHeader(line.content, width));
            return rendered;
         default:
            return rendered;
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
      const gutter = this.options.showLineNumbers
         ? `${fgRgb(CATPPUCCIN_VPALETTE.overlay1)}${lineNumStr} ${fgRgb(signColor)}${sign} `
         : fgRgb(signColor);
      const blankGutter = ' '.repeat(gutterWidth);

      if (
         this.options.wrapLines &&
         ex_length(displayContent, this.widthRedundancyLv) > contentWidth
      ) {
         const wrapped = strWrap(displayContent, contentWidth, {
            mode: 'strict',
            redundancyLv: this.widthRedundancyLv,
         });
         let splitted = wrapped.split('\n');

         if (splitted.length < 2) {
            logger.warn(
               `Expected wrapped content to have multiple lines but got a line or less. Original content length: ${displayContent.length}, Wrapped content length: ${splitted[0]?.length}, ex_length length: ${ex_length(splitted[0], this.widthRedundancyLv)}, avaliable space: ${contentWidth}`,
            );
         }

         // Heuristic check: if the first line still exceeds the content width after wrapping, it likely means wrapping failed to split the line properly (e.g. due to long unbreakable sequences). In this case, we force a split at the content width as a fallback to prevent rendering issues.
         // Redundancy level is locked to 0, bc calculating length with higher redundancy can be too expensive for this check
         if (ex_length(splitted[0], Math.min(this.widthRedundancyLv, 0)) > contentWidth) {
            logger.warn(
               `First line of wrapped content still exceeds available width, countermeasures will be taken. Original content length: ${displayContent.length}, First line length: ${splitted[0]?.length}, ex_length length: ${ex_length(splitted[0], this.widthRedundancyLv)}, avaliable space: ${contentWidth}`,
            );

            // Fallback: force split without relying on wrapping (handles edge cases where wrapping fails to split)
            splitted = [];
            let splitCursor = 0;
            while (splitCursor < ex_length(displayContent, this.widthRedundancyLv)) {
               const chunk = strSlice(
                  displayContent,
                  splitCursor,
                  splitCursor + contentWidth,
                  this.widthRedundancyLv
               );
               splitted.push(chunk);
               splitCursor += ex_length(chunk, this.widthRedundancyLv);
            }
         }

         let lastStyles;
         for (let i = 0; i < splitted.length; i++) {
            const g = i === 0 ? gutter : blankGutter;

            if (lastStyles) splitted[i] = serializeAnsiStyles(lastStyles) + splitted[i];
            rendered.push(this.padLineWithBg(g + bgRgb(bgCode) + splitted[i], width, gutterBgCode));
            // v we put gutter here because the color of the sign should be consistent across wrapped lines.
            // Sign color are design to leak into the content color that acts as default text color for that line.
            if (i !== splitted.length - 1) lastStyles = inferAnsiStyles(g + splitted[i]);
         }
      } else {
         rendered.push(
            this.padLineWithBg(gutter + bgRgb(bgCode) + displayContent, width, gutterBgCode)
         );
      }
      return rendered;
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
      return `${bgRgb(bgColor)}${str}${' '.repeat(padding)}${SGR.reset}`;
   }

   private renderHunkHeader(content: string, width: number, contentWidth: number): string {
      const bgCode = colorMix(CATPPUCCIN_VPALETTE.crust, CATPPUCCIN_VPALETTE.surface0, 0.3);
      content = strLimit(content, contentWidth, 'end', this.redundancyLv);

      return this.padLineWithBg(
         `${SGR.dim + bgRgb(CATPPUCCIN_VPALETTE.cyan) + fgRgb(bgCode)}    ↕   ${bgRgb(bgCode) + fgRgb(CATPPUCCIN_VPALETTE.cyan)} ${STYLES.italic(content)}`,
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
            mode: 'strict',
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
      const emptyLine = `${bgCode}${' '.repeat(width)}${SGR.reset}`;
      const renderLLen = this.renderedLines.length;

      for (let i = 0; i < height - 1; i++) {
         const lineIndex = startLine + i;
         result.push(lineIndex < renderLLen ? this.renderedLines[lineIndex] : emptyLine);
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

   updateOptions(options: Partial<PagerOptions>): void {
      this.options = {
         ...this.options,
         ...options,
      };
      this.updateRenderedLines();
   }
}

export async function viewDiff(
   diffText: string,
   options: DiffViewerOptions = {}
): Promise<PagerActionResult | void> {
   diffText = normalizeDiffLineEndings(diffText);

   if (!canUseDiffViewer()) {
      logger.warn(
         'Diff viewer is not supported in this environment. Falling back to plain output.',
      );
      return pager(diffText, { ...options, showLineNumbers: false });
   }

   const spinnerCtrl = spinner({
      message: diffText.length > 10000 ? 'Preparing diff viewer...' : undefined,
      interval: 20,
   });

   const { body: diffBody, preamble: preambleLines } = separatePreamble(diffText);
   const config = await getConfig();
   const highlightingConfig = {
      fullfileHighlight: config.get<boolean>('viewer.highlighting.fullfileHighlight', true),
      maxHunkSize: config.get<number>('viewer.highlighting.maxHunkSize', 200000),
      ...options.highlighting,
   };

   logger.time('Preparing diff highlighting');
   const renderer = new DiffViewerRenderer(diffBody, {
      ...options,
      preambleLines,
      highlighting: highlightingConfig,
   });
   await renderer.prepareHighlighting(spinnerCtrl);
   clearTerminalCache();
   renderer.onResize(getTerminalWidth(), getTerminalHeight());
   spinnerCtrl.stop();
   logger.timeEnd('Preparing diff highlighting');

   return pagerWithRenderer(renderer, {
      ...options,
      showLineNumbers: true,
   });
}

/**
 * Simple check to see if the text looks like git diff output. Not foolproof but good enough for deciding when to use the diff viewer.
 */
export function isGitDiffOutput(text: string): boolean {
   return DIFF_HEADER_TEXT_REGEX.test(text);
}

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
   const lines = normalizeDiffLineEndings(diffText).split('\n');
   const firstDiffIndex = lines.findIndex((line) => DIFF_HEADER_LINE_REGEX.test(line));
   if (firstDiffIndex === -1) {
      const hasCommitHeader = lines.some((line) =>
         /^(?:commit |Commit:\s+)[0-9a-f]{7,40}\b/i.test(line)
      );
      if (hasCommitHeader) return { body: '', preamble: lines };
      return { body: diffText, preamble: [] };
   }
   return {
      body: lines.slice(firstDiffIndex).join('\n'),
      preamble: lines.slice(0, firstDiffIndex),
   };
}
