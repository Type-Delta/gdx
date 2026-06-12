import { Err, toShortNum } from '@lib/Tools';

import { $ } from '@/modules/shell';
import { parseDiffOutput } from '@/modules/diff-viewer';
import { buildPathGlobMatcher } from '@/utils/glob';
import { COMMIT_DEFAULT_NOISY_FILES } from '@/common/config/schema';
import { DiffModule } from '@/common/types';
import Logger from '@/utils/logger';

type DiffChange = {
   added?: boolean;
   removed?: boolean;
   value: string;
};

type DiffCharsFn = (oldStr: string, newStr: string) => DiffChange[];

interface NameStatusEntry {
   status: string;
   path: string;
   oldPath?: string;
}

interface NumstatEntry {
   added: number | null;
   deleted: number | null;
   isBinary: boolean;
}

interface BinaryStatEntry {
   beforeBytes: number;
   afterBytes: number;
}

interface PatchHunkLine {
   type: 'context' | 'add' | 'delete';
   content: string;
   oldCursorStart: number;
   newCursorStart: number;
   whitespaceOnlyChange?: boolean;
   nonWhitespaceChange?: boolean;
}

interface PatchHunk {
   oldStart: number;
   newStart: number;
   lines: PatchHunkLine[];
}

interface ParsedPatchFile {
   path: string;
   oldPath: string;
   headerLines: string[];
   hunks: PatchHunk[];
}

type FileCategory = 'rename' | 'copy' | 'binary' | 'noisy' | 'normal';

interface ClassifiedFile {
   status: string;
   path: string;
   oldPath?: string;
   added: number | null;
   deleted: number | null;
   isBinary: boolean;
   binaryStat?: BinaryStatEntry;
   category: FileCategory;
}

interface SerializedHunk {
   text: string;
   importance: number;
   size: number;
}

interface SerializedFilePatchResult {
   text: string;
   whitespaceOnlyFile: boolean;
   whitespaceOnlyHunksOmitted: number;
   droppedLowImportanceHunks: number;
   hardTrimmed: boolean;
}

export interface CommitDiffSummaryOptions {
   normalFileCharCap?: number;
   noisyFileCharCap?: number;
   noisyPatterns?: string[];
}

export interface CommitDiffSummaryResult {
   hasChanges: boolean;
   summary: string;
}

const DEFAULT_NORMAL_FILE_CHAR_CAP = 50_000;
const DEFAULT_NOISY_FILE_CHAR_CAP = 1_000;

let diffCharsPromise: Promise<DiffCharsFn | null> | null = null;

/**
 * Builds a staged diff summary optimized for LLM commit message generation.
 *
 * The output intentionally keeps high-signal file changes while trimming
 * whitespace-only and low-importance hunks when files exceed category budgets.
 *
 * @param git$ - Git executable (or scoped command array).
 * @param options - Optional character budget overrides.
 * @returns Structured summary text and a staged-changes presence flag.
 */
export async function buildStagedCommitDiffSummary(
   git$: string | string[],
   options: CommitDiffSummaryOptions = {}
): Promise<CommitDiffSummaryResult> {
   const normalFileCharCap = options.normalFileCharCap ?? DEFAULT_NORMAL_FILE_CHAR_CAP;
   const noisyFileCharCap = options.noisyFileCharCap ?? DEFAULT_NOISY_FILE_CHAR_CAP;
   const noisyMatchers = (options.noisyPatterns || [...COMMIT_DEFAULT_NOISY_FILES])
      .map((pattern) => buildPathGlobMatcher(pattern))
      .filter((matcher): matcher is (value: string) => boolean => Boolean(matcher));
   if (noisyMatchers.length === 0) {
      noisyMatchers.push(() => false);
   }

   const [nameStatusOut, numstatOut, statOut, shortstatOut, patchOut] = await Promise.all([
      $`${git$} diff --cached --name-status -z -M -C --find-copies-harder`,
      $`${git$} diff --cached --numstat -z -M -C --find-copies-harder`,
      $`${git$} -c color.ui=never diff --cached --stat -M -C --find-copies-harder`,
      $`${git$} diff --cached --shortstat`,
      $`${git$} -c color.ui=never diff --cached --patch --no-ext-diff -M -C --find-copies-harder`,
   ]);

   const nameStatusEntries = parseNameStatusZ(nameStatusOut.stdout);
   if (nameStatusEntries.length === 0) {
      return {
         hasChanges: false,
         summary: '',
      };
   }

   const movePathMap = new Map<string, string[]>();
   for (const entry of nameStatusEntries) {
      if (entry.oldPath) {
         const existing = movePathMap.get(entry.oldPath);
         if (existing) existing.push(entry.path);
         else movePathMap.set(entry.oldPath, [entry.path]);
      }
   }

   const numstatMap = parseNumstatZ(numstatOut.stdout, movePathMap);
   const binaryStatMap = parseBinaryStat(statOut.stdout);
   const patchMap = parsePatchByFile(patchOut.stdout);
   const diffChars = await getDiffChars();

   const classifiedFiles = classifyFiles(
      nameStatusEntries,
      numstatMap,
      binaryStatMap,
      noisyMatchers
   );

   const normalDiffChunks: string[] = [];
   const noisyDiffChunks: string[] = [];
   const renameDiffChunks: string[] = [];
   const copyDiffChunks: string[] = [];
   const whitespaceOnlyLines: string[] = [];
   const omittedNotes: string[] = [];

   for (const file of classifiedFiles) {
      if (file.category === 'binary') {
         continue;
      }

      if (file.category === 'rename' || file.category === 'copy') {
         const patchFile =
            patchMap.get(file.path) || (file.oldPath ? patchMap.get(file.oldPath) : undefined);
         if (!hasMoveContentDrift(file.status, patchFile)) {
            continue;
         }
         if (!patchFile) continue;

         const isNoisyMove =
            isNoisyPath(file.path, noisyMatchers) ||
            (file.oldPath ? isNoisyPath(file.oldPath, noisyMatchers) : false);
         const serialized = serializeTrimmedPatchFile(
            patchFile,
            diffChars,
            isNoisyMove ? noisyFileCharCap : normalFileCharCap,
            isNoisyMove
         );

         if (serialized.whitespaceOnlyFile) {
            whitespaceOnlyLines.push(`- ${file.path}: only whitespace-only changes were detected.`);
            continue;
         }

         if (serialized.whitespaceOnlyHunksOmitted > 0) {
            omittedNotes.push(
               `${file.path}: omitted ${serialized.whitespaceOnlyHunksOmitted} whitespace-only hunk(s).`
            );
         }
         if (serialized.droppedLowImportanceHunks > 0) {
            omittedNotes.push(
               `${file.path}: dropped ${serialized.droppedLowImportanceHunks} low-importance hunk(s) to fit budget.`
            );
         }
         if (serialized.hardTrimmed) {
            omittedNotes.push(
               `${file.path}: noisy diff still exceeded budget and was hard-trimmed to ${noisyFileCharCap} chars.`
            );
         }

         if (file.category === 'rename') renameDiffChunks.push(serialized.text);
         else copyDiffChunks.push(serialized.text);
         continue;
      }

      const patchFile =
         patchMap.get(file.path) || (file.oldPath ? patchMap.get(file.oldPath) : undefined);
      if (!patchFile) {
         continue;
      }

      const isNoisy = file.category === 'noisy';
      const serialized = serializeTrimmedPatchFile(
         patchFile,
         diffChars,
         isNoisy ? noisyFileCharCap : normalFileCharCap,
         isNoisy
      );

      if (serialized.whitespaceOnlyFile) {
         whitespaceOnlyLines.push(`- ${file.path}: only whitespace-only changes were detected.`);
         continue;
      }

      if (serialized.whitespaceOnlyHunksOmitted > 0) {
         omittedNotes.push(
            `${file.path}: omitted ${serialized.whitespaceOnlyHunksOmitted} whitespace-only hunk(s).`
         );
      }
      if (serialized.droppedLowImportanceHunks > 0) {
         omittedNotes.push(
            `${file.path}: dropped ${serialized.droppedLowImportanceHunks} low-importance hunk(s) to fit budget.`
         );
      }
      if (serialized.hardTrimmed) {
         omittedNotes.push(
            `${file.path}: noisy diff still exceeded budget and was hard-trimmed to ${noisyFileCharCap} chars.`
         );
      }

      if (isNoisy) noisyDiffChunks.push(serialized.text);
      else normalDiffChunks.push(serialized.text);
   }

   const shortstat = shortstatOut.stdout.trim();

   const countByCategory = {
      normal: classifiedFiles.filter((f) => f.category === 'normal').length,
      noisy: classifiedFiles.filter((f) => f.category === 'noisy').length,
      binary: classifiedFiles.filter((f) => f.category === 'binary').length,
      copy: classifiedFiles.filter((f) => f.category === 'copy').length,
      rename: classifiedFiles.filter((f) => f.category === 'rename').length,
   };

   const perFileStatsLines = classifiedFiles.map((file) => formatFileStatLine(file));

   const summaryBlocks = [
      '<summary-help-text>',
      'This summary includes trimmed diffs, file-level stats, and other metadata, constructed by analyzing raw git diff. Changes are classified into the following categories:',
      '- normal: text files with typical changes',
      "- noisy: text files that usually don't contain meaningful changes (e.g. lockfiles, minified files)",
      '- binary: non-text files where content changes cannot be meaningfully summarized in text',
      '- rename: files detected as renames/moves (includes similarity score and drift percentage)',
      '- copy: files detected as copies (includes similarity score and drift percentage)',
      '</summary-help-text>',
      '',
      '<changes-overview>',
      shortstat ? `- shortstat: ${shortstat}` : '- shortstat: (empty)',
      `- files: total=${classifiedFiles.length}, normal=${countByCategory.normal}, noisy=${countByCategory.noisy}, binary=${countByCategory.binary}, renames=${countByCategory.rename}, copies=${countByCategory.copy}`,
      '</changes-overview>',
      '',
      '<file-stats>',
      ...perFileStatsLines,
      '</file-stats>',
   ];

   if (whitespaceOnlyLines.length > 0) {
      summaryBlocks.push(
         '',
         '<whitespace-only-changes>',
         ...whitespaceOnlyLines,
         '</whitespace-only-changes>'
      );
   }

   if (renameDiffChunks.length > 0) {
      summaryBlocks.push('', '<rename-diffs>', ...renameDiffChunks, '</rename-diffs>');
   }

   if (copyDiffChunks.length > 0) {
      summaryBlocks.push('', '<copy-diffs>', ...copyDiffChunks, '</copy-diffs>');
   }

   if (normalDiffChunks.length > 0) {
      summaryBlocks.push('', '<normal-text-diffs>', ...normalDiffChunks, '</normal-text-diffs>');
   }

   if (noisyDiffChunks.length > 0) {
      summaryBlocks.push('', '<noisy-text-diffs>', ...noisyDiffChunks, '</noisy-text-diffs>');
   }

   if (omittedNotes.length > 0) {
      summaryBlocks.push(
         '',
         '<system-notes>',
         ...omittedNotes.map((note) => `- ${note}`),
         '</system-notes>'
      );
   }

   return {
      hasChanges: true,
      summary: summaryBlocks.join('\n'),
   };
}

/**
 * Parses `git diff --cached --name-status -z -M -C` output.
 *
 * @param raw - Null-delimited name-status output.
 * @returns Parsed name-status entries.
 */
function parseNameStatusZ(raw: string): NameStatusEntry[] {
   const tokens = raw.split('\0').filter((token) => token.length > 0);
   const entries: NameStatusEntry[] = [];

   for (let i = 0; i < tokens.length;) {
      const status = tokens[i++];
      if (!status) break;

      if (status.startsWith('R') || status.startsWith('C')) {
         const oldPath = tokens[i++];
         const newPath = tokens[i++];
         if (!oldPath || !newPath) break;
         entries.push({ status, path: newPath, oldPath });
         continue;
      }

      const filePath = tokens[i++];
      if (!filePath) break;
      entries.push({ status, path: filePath });
   }

   return entries;
}

/**
 * Parses `git diff --cached --numstat -z` output.
 *
 * @param raw - Null-delimited numstat output.
 * @param movePathMap - Map of old path to rename/copy target paths for move-aware path resolution.
 * @returns A map keyed by resolved file path.
 */
function parseNumstatZ(raw: string, movePathMap: Map<string, string[]>): Map<string, NumstatEntry> {
   const tokens = raw.split('\0');
   const result = new Map<string, NumstatEntry>();

   for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (!token) continue;

      const match = token.match(/^(-|\d+)\t(-|\d+)\t(.+)$/);
      if (match) {
         const addedRaw = match[1];
         const deletedRaw = match[2];
         const path = match[3];
         result.set(path, {
            added: addedRaw === '-' ? null : parseInt(addedRaw, 10),
            deleted: deletedRaw === '-' ? null : parseInt(deletedRaw, 10),
            isBinary: addedRaw === '-' || deletedRaw === '-',
         });
         continue;
      }

      const moveMatch = token.match(/^(-|\d+)\t(-|\d+)\t$/);
      if (!moveMatch) continue;

      const addedRaw = moveMatch[1];
      const deletedRaw = moveMatch[2];
      const oldPath = tokens[i + 1];
      const nextPath = tokens[i + 2];
      if (!oldPath || !nextPath) continue;

      const movedPaths = movePathMap.get(oldPath) || [];
      const resolvedPath = movedPaths.includes(nextPath)
         ? nextPath
         : movedPaths.length === 1
            ? movedPaths[0]
            : nextPath;
      i += 2;

      result.set(resolvedPath, {
         added: addedRaw === '-' ? null : parseInt(addedRaw, 10),
         deleted: deletedRaw === '-' ? null : parseInt(deletedRaw, 10),
         isBinary: addedRaw === '-' || deletedRaw === '-',
      });
   }

   return result;
}

/**
 * Parses `git diff --cached --stat` binary size lines.
 *
 * @param raw - Stat output.
 * @returns Binary size entries keyed by best-effort normalized path.
 */
function parseBinaryStat(raw: string): Map<string, BinaryStatEntry> {
   const result = new Map<string, BinaryStatEntry>();
   const lines = raw.split(/\r?\n/);

   for (const line of lines) {
      const match = line.match(/^\s*(.+?)\s+\|\s+Bin\s+(\d+)\s+->\s+(\d+)\s+bytes\s*$/);
      if (!match) continue;

      const rawPath = match[1].trim();
      const beforeBytes = parseInt(match[2], 10);
      const afterBytes = parseInt(match[3], 10);
      const normalizedPath = normalizeStatPath(rawPath);

      result.set(normalizedPath, { beforeBytes, afterBytes });
   }

   return result;
}

/**
 * Converts path rendering variants from `git --stat` output into a best-effort path.
 *
 * @param statPath - Path segment from stat line.
 * @returns Normalized path candidate.
 */
function normalizeStatPath(statPath: string): string {
   if (statPath.includes('{') && statPath.includes('=>') && statPath.includes('}')) {
      const open = statPath.indexOf('{');
      const close = statPath.indexOf('}', open);
      if (close > open) {
         const prefix = statPath.slice(0, open);
         const suffix = statPath.slice(close + 1);
         const inner = statPath.slice(open + 1, close);
         const innerParts = inner.split('=>');
         if (innerParts.length === 2) {
            const replacement = innerParts[1].trim();
            return `${prefix}${replacement}${suffix}`.trim();
         }
      }
   }

   if (statPath.includes('=>')) {
      const parts = statPath.split('=>');
      return parts[parts.length - 1].trim();
   }

   return statPath;
}

/**
 * Parses staged patch output into per-file hunks with cursor metadata.
 *
 * @param patch - Raw `git diff --cached --patch` output.
 * @returns Map of path -> parsed patch file data.
 */
function parsePatchByFile(patch: string): Map<string, ParsedPatchFile> {
   const parsed = parseDiffOutput(patch);
   const map = new Map<string, ParsedPatchFile>();

   for (const file of parsed) {
      const patchFile: ParsedPatchFile = {
         path: file.newFileName,
         oldPath: file.oldFileName,
         headerLines: [],
         hunks: [],
      };

      let currentHunk: PatchHunk | null = null;
      let oldCursor = 0;
      let newCursor = 0;

      for (const line of file.lines) {
         if (line.type === 'header') {
            if (patchFile.hunks.length === 0) {
               patchFile.headerLines.push(line.content);
            }
            continue;
         }

         if (line.type === 'hunk') {
            const parsedHeader = parseUnifiedHunkHeader(line.content);
            if (!parsedHeader) continue;

            currentHunk = {
               oldStart: parsedHeader.oldStart,
               newStart: parsedHeader.newStart,
               lines: [],
            };
            patchFile.hunks.push(currentHunk);
            oldCursor = parsedHeader.oldStart;
            newCursor = parsedHeader.newStart;
            continue;
         }

         if (!currentHunk) continue;

         if (line.type === 'context') {
            currentHunk.lines.push({
               type: 'context',
               content: line.content,
               oldCursorStart: oldCursor,
               newCursorStart: newCursor,
            });
            oldCursor += 1;
            newCursor += 1;
            continue;
         }

         if (line.type === 'delete') {
            currentHunk.lines.push({
               type: 'delete',
               content: line.content,
               oldCursorStart: oldCursor,
               newCursorStart: newCursor,
            });
            oldCursor += 1;
            continue;
         }

         if (line.type === 'add') {
            currentHunk.lines.push({
               type: 'add',
               content: line.content,
               oldCursorStart: oldCursor,
               newCursorStart: newCursor,
            });
            newCursor += 1;
         }
      }

      map.set(patchFile.path, patchFile);
   }

   return map;
}

/**
 * Parses a unified hunk header line.
 *
 * @param line - Hunk header line (e.g. `@@ -10,3 +11,4 @@`).
 * @returns Parsed hunk range metadata or null.
 */
function parseUnifiedHunkHeader(
   line: string
): { oldStart: number; oldCount: number; newStart: number; newCount: number } | null {
   const match = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
   if (!match) return null;

   return {
      oldStart: parseInt(match[1], 10),
      oldCount: match[2] ? parseInt(match[2], 10) : 1,
      newStart: parseInt(match[3], 10),
      newCount: match[4] ? parseInt(match[4], 10) : 1,
   };
}

/**
 * Classifies staged files into rename/copy/non-text/noisy/normal buckets.
 *
 * @param nameStatusEntries - Entries from name-status parsing.
 * @param numstatMap - Numstat map by path.
 * @param binaryStatMap - Binary size map by path.
 * @returns Classified staged files.
 */
function classifyFiles(
   nameStatusEntries: NameStatusEntry[],
   numstatMap: Map<string, NumstatEntry>,
   binaryStatMap: Map<string, BinaryStatEntry>,
   noisyMatchers: Array<(value: string) => boolean>
): ClassifiedFile[] {
   return nameStatusEntries.map((entry) => {
      const numstat =
         numstatMap.get(entry.path) || (entry.oldPath ? numstatMap.get(entry.oldPath) : undefined);
      const binaryStat =
         binaryStatMap.get(entry.path) ||
         (entry.oldPath ? binaryStatMap.get(entry.oldPath) : undefined) ||
         binaryStatMap.get(normalizeStatPath(entry.path));
      const isRename = entry.status.startsWith('R');
      const isCopy = entry.status.startsWith('C');
      const isBinary = Boolean(numstat?.isBinary);

      let category: FileCategory;
      if (isRename) category = 'rename';
      else if (isCopy) category = 'copy';
      else if (isBinary) category = 'binary';
      else if (isNoisyPath(entry.path, noisyMatchers)) category = 'noisy';
      else category = 'normal';

      return {
         status: entry.status,
         path: entry.path,
         oldPath: entry.oldPath,
         added: numstat?.added ?? 0,
         deleted: numstat?.deleted ?? 0,
         isBinary,
         binaryStat,
         category,
      };
   });
}

/**
 * Extracts similarity and drift percentages from rename/copy status codes.
 *
 * @param status - Name-status token (e.g. `R100`, `C73`).
 * @returns Parsed percentages, or nulls when unavailable.
 */
function parseMoveSimilarity(status: string): {
   similarityPercent: number | null;
   driftPercent: number | null;
} {
   if (!status.startsWith('R') && !status.startsWith('C')) {
      return {
         similarityPercent: null,
         driftPercent: null,
      };
   }

   const similarityRaw = parseInt(status.slice(1), 10);
   if (isNaN(similarityRaw)) {
      return {
         similarityPercent: null,
         driftPercent: null,
      };
   }

   const similarityPercent = Math.min(100, Math.max(0, similarityRaw));
   return {
      similarityPercent,
      driftPercent: 100 - similarityPercent,
   };
}

/**
 * Returns true when a rename/copy has content drift from its source.
 *
 * @param status - Name-status token (e.g. `R100`, `C75`).
 * @param patchFile - Parsed patch for move target.
 * @returns True when move content changed from original.
 */
function hasMoveContentDrift(status: string, patchFile?: ParsedPatchFile): boolean {
   const moveSimilarity = parseMoveSimilarity(status);
   if (moveSimilarity.driftPercent != null) {
      return moveSimilarity.driftPercent > 0;
   }

   if (!patchFile) return false;
   return patchFile.hunks.some((hunk) =>
      hunk.lines.some((line) => line.type === 'add' || line.type === 'delete')
   );
}

/**
 * Formats one file-stat entry according to file category.
 *
 * @param file - Classified staged file metadata.
 * @returns Human-readable file stats line.
 */
function formatFileStatLine(file: ClassifiedFile): string {
   if (file.category === 'rename' || file.category === 'copy') {
      const moveKind = file.category;
      const moveSimilarity = parseMoveSimilarity(file.status);
      const driftLabel =
         moveSimilarity.driftPercent == null
            ? '(similarity unknown)'
            : moveSimilarity.driftPercent === 0
               ? '(identical)'
               : `(drift ~${moveSimilarity.driftPercent}%)`;
      return `- ${file.status[0]} [${moveKind}] ${file.oldPath || file.path} -> ${file.path} ${driftLabel}`;
   }

   if (file.category === 'binary') {
      const sizeText = file.binaryStat
         ? `${toShortNum(file.binaryStat.beforeBytes, 1, 1024)} -> ${toShortNum(file.binaryStat.afterBytes, 1, 1024)} bytes`
         : 'binary size unavailable';
      return `- ${file.status} [binary] ${file.path} (${sizeText})`;
   }

   const plusMinus =
      file.added == null || file.deleted == null
         ? '(line stats unavailable)'
         : `(+${file.added} -${file.deleted})`;
   return `- ${file.status} [${file.category}] ${file.path} ${plusMinus}`;
}

/**
 * Serializes a parsed text file patch after whitespace-aware trimming and
 * category-specific budget enforcement.
 *
 * @param patchFile - Parsed per-file patch data.
 * @param diffChars - Character diff function for whitespace-only detection.
 * @param charCap - File-level character cap.
 * @param isNoisy - True when file is in noisy category.
 * @returns Serialized patch plus trimming metadata.
 */
function serializeTrimmedPatchFile(
   patchFile: ParsedPatchFile,
   diffChars: DiffCharsFn | null,
   charCap: number,
   isNoisy: boolean
): SerializedFilePatchResult {
   if (patchFile.hunks.length === 0) {
      const text = serializeFileWithHunks(patchFile, []);
      if (!isNoisy || text.length <= charCap) {
         return {
            text,
            whitespaceOnlyFile: false,
            whitespaceOnlyHunksOmitted: 0,
            droppedLowImportanceHunks: 0,
            hardTrimmed: false,
         };
      }

      return {
         text: text.slice(0, charCap),
         whitespaceOnlyFile: false,
         whitespaceOnlyHunksOmitted: 0,
         droppedLowImportanceHunks: 0,
         hardTrimmed: true,
      };
   }

   const serializedHunks: SerializedHunk[] = [];
   let whitespaceOnlyHunksOmitted = 0;
   let hasNonWhitespaceFileChange = false;

   for (const hunk of patchFile.hunks) {
      const annotatedLines = annotateWhitespaceOnlyChangeLines(hunk.lines, diffChars);
      const hasNonWhitespaceChanges = annotatedLines.some((line) => line.nonWhitespaceChange);
      const hasWhitespaceOnlyChanges = annotatedLines.some((line) => line.whitespaceOnlyChange);

      if (!hasNonWhitespaceChanges && hasWhitespaceOnlyChanges) {
         whitespaceOnlyHunksOmitted += 1;
         continue;
      }

      hasNonWhitespaceFileChange ||= hasNonWhitespaceChanges;

      const filteredLines = filterHunkLines(annotatedLines);
      const splitGroups = splitLinesOnCursorJump(filteredLines);

      for (const group of splitGroups) {
         if (!group.some((line) => line.type === 'add' || line.type === 'delete')) continue;

         const hunkText = serializeSyntheticHunk(group);
         const importance = group.reduce((acc, line) => {
            if ((line.type === 'add' || line.type === 'delete') && line.nonWhitespaceChange) {
               return acc + 1;
            }
            return acc;
         }, 0);

         serializedHunks.push({
            text: hunkText,
            importance,
            size: hunkText.length,
         });
      }
   }

   if (!hasNonWhitespaceFileChange) {
      return {
         text: '',
         whitespaceOnlyFile: true,
         whitespaceOnlyHunksOmitted,
         droppedLowImportanceHunks: 0,
         hardTrimmed: false,
      };
   }

   let droppedLowImportanceHunks = 0;
   const selectedHunks = [...serializedHunks];

   let serializedText = serializeFileWithHunks(
      patchFile,
      selectedHunks.map((hunk) => hunk.text)
   );
   if (serializedText.length > charCap && selectedHunks.length > 0) {
      const dropCandidates = [...selectedHunks].sort((a, b) => {
         if (a.importance !== b.importance) return a.importance - b.importance;
         return b.size - a.size;
      });

      while (serializedText.length > charCap && selectedHunks.length > 0) {
         const candidate = dropCandidates.shift();
         if (!candidate) break;

         const idx = selectedHunks.indexOf(candidate);
         if (idx === -1) continue;
         selectedHunks.splice(idx, 1);
         droppedLowImportanceHunks += 1;
         serializedText = serializeFileWithHunks(
            patchFile,
            selectedHunks.map((hunk) => hunk.text)
         );
      }
   }

   let hardTrimmed = false;
   if (isNoisy && serializedText.length > charCap) {
      hardTrimmed = true;
      serializedText = serializedText.slice(0, charCap);
   }

   return {
      text: serializedText,
      whitespaceOnlyFile: false,
      whitespaceOnlyHunksOmitted,
      droppedLowImportanceHunks,
      hardTrimmed,
   };
}

/**
 * Annotates hunk lines by detecting whitespace-only add/delete changes.
 *
 * @param lines - Hunk lines.
 * @param diffChars - Character diff function.
 * @returns Annotated hunk lines.
 */
function annotateWhitespaceOnlyChangeLines(
   lines: PatchHunkLine[],
   diffChars: DiffCharsFn | null
): PatchHunkLine[] {
   const clonedLines = lines.map((line) => ({ ...line }));

   for (let i = 0; i < clonedLines.length; i++) {
      if (clonedLines[i].type !== 'add' && clonedLines[i].type !== 'delete') continue;

      const start = i;
      while (
         i < clonedLines.length &&
         (clonedLines[i].type === 'add' || clonedLines[i].type === 'delete')
      ) {
         i += 1;
      }

      const block = clonedLines.slice(start, i);
      const deleted = block.filter((line) => line.type === 'delete');
      const added = block.filter((line) => line.type === 'add');
      const pairedCount = Math.min(deleted.length, added.length);

      for (let pairIndex = 0; pairIndex < pairedCount; pairIndex++) {
         const oldLine = deleted[pairIndex];
         const newLine = added[pairIndex];
         if (isWhitespaceOnlyTextChange(oldLine.content, newLine.content, diffChars)) {
            oldLine.whitespaceOnlyChange = true;
            newLine.whitespaceOnlyChange = true;
         } else {
            oldLine.nonWhitespaceChange = true;
            newLine.nonWhitespaceChange = true;
         }
      }

      for (let j = pairedCount; j < deleted.length; j++) {
         deleted[j].nonWhitespaceChange = true;
      }
      for (let j = pairedCount; j < added.length; j++) {
         added[j].nonWhitespaceChange = true;
      }

      const blockHasNonWhitespace = block.some((line) => line.nonWhitespaceChange);
      if (!blockHasNonWhitespace) {
         const oldBlockText = deleted.map((line) => line.content).join('\n');
         const newBlockText = added.map((line) => line.content).join('\n');
         if (!isWhitespaceOnlyTextChange(oldBlockText, newBlockText, diffChars)) {
            for (const line of deleted) {
               line.nonWhitespaceChange = true;
               line.whitespaceOnlyChange = false;
            }
            for (const line of added) {
               line.nonWhitespaceChange = true;
               line.whitespaceOnlyChange = false;
            }
         }
      }

      i -= 1;
   }

   return clonedLines;
}

/**
 * Checks if a replaced line pair differs only by whitespace.
 *
 * @param oldLine - Previous line content.
 * @param newLine - Updated line content.
 * @param diffChars - Character diff function.
 * @returns True when all changed characters are whitespace.
 */
function isWhitespaceOnlyTextChange(
   oldText: string,
   newText: string,
   diffChars: DiffCharsFn | null
): boolean {
   if (oldText === newText) return false;

   if (!diffChars) {
      const oldCollapsed = oldText.replace(/\s+/g, '');
      const newCollapsed = newText.replace(/\s+/g, '');
      return oldCollapsed === newCollapsed;
   }

   const diff = diffChars(oldText, newText);
   const changedChunks = diff.filter((chunk) => chunk.added || chunk.removed);
   if (changedChunks.length === 0) return false;

   return changedChunks.every((chunk) => /^\s*$/.test(chunk.value));
}

/**
 * Applies whitespace-trimming rules to a single hunk.
 *
 * Rules:
 * - Keep all context lines by default.
 * - Keep all non-whitespace add/delete lines.
 * - For runs of whitespace-only changed lines adjacent to non-whitespace changes,
 *   keep at most one line on each adjacent side as context.
 *
 * @param lines - Annotated hunk lines.
 * @returns Filtered lines.
 */
function filterHunkLines(lines: PatchHunkLine[]): PatchHunkLine[] {
   const keep = new Set<number>();

   for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.type === 'context') {
         keep.add(i);
         continue;
      }
      if (line.nonWhitespaceChange) {
         keep.add(i);
      }
   }

   for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!(line.type === 'add' || line.type === 'delete') || !line.whitespaceOnlyChange) continue;

      const start = i;
      while (
         i < lines.length &&
         (lines[i].type === 'add' || lines[i].type === 'delete') &&
         lines[i].whitespaceOnlyChange
      ) {
         i += 1;
      }
      const end = i - 1;

      const leftNeighbor = lines[start - 1];
      const rightNeighbor = lines[end + 1];
      const leftAdjacentToNonWhitespace =
         Boolean(leftNeighbor) &&
         (leftNeighbor.type === 'add' || leftNeighbor.type === 'delete') &&
         Boolean(leftNeighbor.nonWhitespaceChange);
      const rightAdjacentToNonWhitespace =
         Boolean(rightNeighbor) &&
         (rightNeighbor.type === 'add' || rightNeighbor.type === 'delete') &&
         Boolean(rightNeighbor.nonWhitespaceChange);

      if (leftAdjacentToNonWhitespace) keep.add(start);
      if (rightAdjacentToNonWhitespace) keep.add(end);

      i -= 1;
   }

   const filtered: PatchHunkLine[] = [];
   for (const index of [...keep].sort((a, b) => a - b)) {
      filtered.push(lines[index]);
   }
   return filtered;
}

/**
 * Splits filtered hunk lines whenever old/new cursors become discontinuous.
 *
 * @param lines - Filtered hunk lines.
 * @returns Cursor-contiguous line groups.
 */
function splitLinesOnCursorJump(lines: PatchHunkLine[]): PatchHunkLine[][] {
   if (lines.length === 0) return [];

   const groups: PatchHunkLine[][] = [];
   let group: PatchHunkLine[] = [lines[0]];

   for (let i = 1; i < lines.length; i++) {
      const prev = lines[i - 1];
      const curr = lines[i];

      const expectedOld = prev.oldCursorStart + (prev.type === 'add' ? 0 : 1);
      const expectedNew = prev.newCursorStart + (prev.type === 'delete' ? 0 : 1);

      if (curr.oldCursorStart !== expectedOld || curr.newCursorStart !== expectedNew) {
         groups.push(group);
         group = [curr];
         continue;
      }

      group.push(curr);
   }

   if (group.length > 0) groups.push(group);
   return groups;
}

/**
 * Serializes a synthetic hunk with recalculated line ranges.
 *
 * @param lines - Cursor-contiguous hunk lines.
 * @returns Unified hunk text.
 */
function serializeSyntheticHunk(lines: PatchHunkLine[]): string {
   if (lines.length === 0) return '';

   const oldStart = lines[0].oldCursorStart;
   const newStart = lines[0].newCursorStart;
   const oldCount = lines.reduce((acc, line) => acc + (line.type === 'add' ? 0 : 1), 0);
   const newCount = lines.reduce((acc, line) => acc + (line.type === 'delete' ? 0 : 1), 0);

   const hunkHeader = `@@ -${formatUnifiedRange(oldStart, oldCount)} +${formatUnifiedRange(newStart, newCount)} @@`;
   const bodyLines = lines.map((line) => {
      if (line.type === 'context') return ` ${line.content}`;
      if (line.type === 'add') return `+${line.content}`;
      return `-${line.content}`;
   });

   return [hunkHeader, ...bodyLines].join('\n');
}

/**
 * Formats a unified-diff range segment.
 *
 * @param start - Range start line.
 * @param count - Range length.
 * @returns Unified range token.
 */
function formatUnifiedRange(start: number, count: number): string {
   if (count === 1) return String(start);
   return `${start},${count}`;
}

/**
 * Serializes a full file patch from headers and synthetic hunk text chunks.
 *
 * @param file - Parsed patch file.
 * @param serializedHunks - Serialized hunks to include.
 * @returns File patch text.
 */
function serializeFileWithHunks(file: ParsedPatchFile, serializedHunks: string[]): string {
   const header = [`diff --git a/${file.oldPath} b/${file.path}`, ...file.headerLines];
   const chunks = [...header, ...serializedHunks].filter((line) => line.length > 0);
   return chunks.join('\n');
}

/**
 * Returns true if a file path matches default noisy-file patterns.
 *
 * @param filePath - Relative file path from git diff output.
 * @returns Noise classification flag.
 */
function isNoisyPath(filePath: string, noisyMatchers: Array<(value: string) => boolean>): boolean {
   return noisyMatchers.some((matcher) => matcher(filePath));
}

/**
 * Loads the `diffChars` function from the `diff` dependency.
 *
 * @returns Character diff function, or null when loading fails.
 */
async function getDiffChars(): Promise<DiffCharsFn | null> {
   diffCharsPromise ??= (async () => {
      try {
         const diffLib = await import('./diff-lite') as Awaited<DiffModule>;
         return diffLib.diffChars;
      } catch (error) {
         Logger.debug(
            `Failed to load diff module for whitespace-aware commit summary: ${Err.from(error).message}`,
            'diff-summary'
         );
         return null;
      }
   })();
   return await diffCharsPromise;
}
