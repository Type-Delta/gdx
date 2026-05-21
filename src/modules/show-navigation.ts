import { strLimit } from '@lib/Tools';

import { GdxContext } from '@/common/types';
import { CATPPUCCIN_VPALETTE, EXTENSION_LANG_MAP, SGR, TUI_THEME } from '@/consts';
import { isGitDiffOutput, viewDiff } from '@/modules/diff-viewer';
import { pager } from '@/modules/pager';
import { $, spinner } from '@/modules/shell';
import { fgRgb } from './graphics';
import { resolveHeadRelativeCommitRef, revParseCached } from './git';
import type { PagerAction } from './pager';
import Logger from '@/utils/logger';

const DIFF_HEADER_LINE_REGEX = /^diff --(git|cc|combined)\b/;
const SHOW_COMMIT_HEADER_LINE_REGEX = /^commit [0-9a-f]{7,40}\b/i;
const SHOW_PREVIOUS_COMMIT_ACTION = 'previousCommit';
const SHOW_NEXT_COMMIT_ACTION = 'nextCommit';
const LEFT_ARROW_KEY = '\x1b[D';
const RIGHT_ARROW_KEY = '\x1b[C';
const SHOW_NAVIGATION_VALUE_OPTIONS = new Set([
   '--author',
   '--committer',
   '--grep',
   '--grep-reflog',
   '--since',
   '--after',
   '--until',
   '--before',
   '--max-count',
   '--skip',
   '--diff-filter',
   '--branches',
   '--tags',
   '--remotes',
   '--glob',
   '--exclude',
   '--date',
   '--decorate',
   '--encoding',
   '--notes',
   '--pretty',
   '--format',
   '-n',
   '-L',
]);

export interface ShowCommitNavigationPlan {
   targetRef: string;
   targetIndex: number | null;
   navigationArgs: string[];
}

export interface ShowBlobNavigationPlan extends ShowCommitNavigationPlan {
   path: string;
   isIndexStage: boolean;
}

export interface ShowCommitAdjacentCommits {
   previous: string | null;
   next: string | null;
}

/**
 * Builds the git-show argument list for a resolved commit while preserving the user's options
 * and pathspec filters.
 * @param showArgs - Arguments passed after `gdx show`.
 * @param plan - Parsed commit navigation plan for the original arguments.
 * @param commit - The commit hash or ref to display.
 * @returns A show argument list targeting the requested commit.
 */
export function buildShowArgsForCommit(
   showArgs: string[],
   plan: ShowCommitNavigationPlan,
   commit: string
): string[] {
   const nextArgs = showArgs.slice();
   if (plan.targetIndex === null) {
      const terminatorIndex = nextArgs.indexOf('--');
      nextArgs.splice(terminatorIndex === -1 ? 0 : terminatorIndex, 0, commit);
      return nextArgs;
   }

   nextArgs[plan.targetIndex] = commit;
   return nextArgs;
}

/**
 * Parses `git show` arguments into a target commit and a `git log` argument list used for
 * adjacent-commit lookup. Pathspecs and log filtering options are preserved.
 * @param showArgs - Arguments passed after `gdx show`.
 * @returns The parsed target and navigation arguments.
 */
export function buildShowCommitNavigationPlan(showArgs: string[]): ShowCommitNavigationPlan {
   const terminatorIndex = showArgs.indexOf('--');
   const searchEnd = terminatorIndex === -1 ? showArgs.length : terminatorIndex;
   let targetIndex: number | null = null;

   for (let index = 0; index < searchEnd; index++) {
      const arg = showArgs[index];
      if (!arg) continue;

      if (isOptionTokenWithSeparateValue(arg) && index + 1 < searchEnd) {
         index++;
         continue;
      }

      if (arg.startsWith('-')) continue;

      targetIndex = index;
      break;
   }

   const targetRef = targetIndex === null ? 'HEAD' : showArgs[targetIndex];
   const navigationArgs = showArgs.filter((_, index) => index !== targetIndex);
   const navigationTerminatorIndex = navigationArgs.indexOf('--');
   const insertIndex =
      navigationTerminatorIndex === -1 ? navigationArgs.length : navigationTerminatorIndex;
   navigationArgs.splice(insertIndex, 0, 'HEAD');

   return {
      targetRef,
      targetIndex,
      navigationArgs,
   };
}

/**
 * Parses `git show <revision>:<path>` arguments into a navigation plan.
 * @param showArgs - Arguments passed after `gdx show`.
 * @returns The parsed blob target and navigation arguments, or null for non-blob show args.
 */
export function buildShowBlobNavigationPlan(showArgs: string[]): ShowBlobNavigationPlan | null {
   const terminatorIndex = showArgs.indexOf('--');
   const searchEnd = terminatorIndex === -1 ? showArgs.length : terminatorIndex;

   for (let index = 0; index < searchEnd; index++) {
      const arg = showArgs[index];
      if (!arg) continue;

      if (isOptionTokenWithSeparateValue(arg) && index + 1 < searchEnd) {
         index++;
         continue;
      }

      if (arg.startsWith('-')) continue;

      if (arg.startsWith(':')) {
         const indexPathMatch = arg.match(/^:(?:[0-3]:)?(.+)$/);
         if (!indexPathMatch) return null;

         return {
            targetRef: '',
            targetIndex: index,
            navigationArgs: [],
            path: indexPathMatch[1],
            isIndexStage: true,
         };
      }

      const separatorIndex = arg.indexOf(':');
      if (separatorIndex <= 0 || separatorIndex === arg.length - 1) return null;

      const targetRef = arg.slice(0, separatorIndex);
      const path = arg.slice(separatorIndex + 1);
      const navigationArgs = showArgs.filter(
         (_, argIndex) => argIndex !== index && argIndex < searchEnd
      );
      navigationArgs.push('HEAD', '--', path);

      return {
         targetRef,
         targetIndex: index,
         navigationArgs,
         path,
         isIndexStage: false,
      };
   }

   return null;
}

/**
 * Builds the `git show` argument list for a blob at a resolved commit.
 * @param showArgs - Arguments passed after `gdx show`.
 * @param plan - Parsed blob navigation plan.
 * @param commit - The commit hash or ref to display.
 * @returns A show argument list targeting the blob at the requested commit.
 */
export function buildShowBlobArgsForCommit(
   showArgs: string[],
   plan: ShowBlobNavigationPlan,
   commit: string
): string[] {
   const nextArgs = showArgs.slice();
   if (plan.isIndexStage) return nextArgs;
   if (plan.targetIndex !== null) nextArgs[plan.targetIndex] = `${commit}:${plan.path}`;
   return nextArgs;
}

/**
 * Returns true when show args use git's line-log mode.
 * @param showArgs - Arguments passed after `gdx show`.
 */
function hasLineLogOption(showArgs: string[]): boolean {
   return showArgs.some((arg) => arg === '-L' || arg.startsWith('-L:') || arg.startsWith('-L/'));
}

/**
 * Returns true when the option consumes the next argument as its value.
 * @param arg - Candidate git-show option token.
 * @returns True if the next token should not be treated as a revision.
 */
function isOptionTokenWithSeparateValue(arg: string): boolean {
   if (arg.includes('=')) return false;
   if (SHOW_NAVIGATION_VALUE_OPTIONS.has(arg)) return true;
   if (/^-n\d+$/.test(arg)) return false;
   return false;
}

/**
 * Clears the terminal before loading another interactive show view.
 */
function clearInteractiveScreen(): void {
   if (!process.stdout.isTTY) return;
   process.stdout.write('\x1b[2J\x1b[H');
}

/**
 * Resolves a commit-ish value to a full commit hash.
 * @param git$ - Git executable/context from GdxContext.
 * @param ref - Commit-ish ref to resolve.
 * @returns Full commit hash.
 */
async function resolveShowCommit(git$: GdxContext['git$'], ref: string): Promise<string> {
   return revParseCached(git$, ['--verify', `${ref}^{commit}`]);
}

/**
 * Loads the file-stat section for the shown commit while preserving show options and pathspecs.
 * @param git$ - Git executable/context from GdxContext.
 * @param showArgs - Arguments passed after `gdx show`.
 * @param plan - Parsed commit navigation plan for the original arguments.
 * @param commit - Commit hash to show stats for.
 * @returns The raw stat output from git show.
 */
async function getShowCommitStat(
   git$: GdxContext['git$'],
   showArgs: string[],
   plan: ShowCommitNavigationPlan,
   commit: string
): Promise<string> {
   if (hasLineLogOption(showArgs)) return '';

   return (
      await $`${git$} -c color.ui=never show --stat --format= ${buildShowArgsForCommit(
         showArgs,
         plan,
         commit
      )}`
   ).stdout
      .trimEnd()
      .replace(/(\W)(\++)/g, `$1${SGR.green}$2${fgRgb(CATPPUCCIN_VPALETTE.overlay0)}`)
      .replace(/(\W|\d{1,3}m)(-+)/g, `$1${SGR.red}$2${fgRgb(CATPPUCCIN_VPALETTE.overlay0)}`);
}

/**
 * Splits a git-show output into its preamble and diff body.
 * @param diffText - Raw git show output.
 * @returns Preamble lines and diff body.
 */
export function separateShowPreamble(diffText: string): { body: string; preamble: string[] } {
   const lines = diffText.split('\n');
   const firstDiffIndex = lines.findIndex((line) => DIFF_HEADER_LINE_REGEX.test(line));
   if (firstDiffIndex === -1) {
      if (isGitShowCommitOutput(diffText)) return { body: '', preamble: lines };
      return { body: diffText, preamble: [] };
   }
   return {
      body: lines.slice(firstDiffIndex).join('\n'),
      preamble: lines.slice(0, firstDiffIndex),
   };
}

/**
 * Returns true when text looks like commit-oriented `git show` output.
 * This includes commits without file changes, which have no diff header.
 * @param text - Raw git-show output.
 */
export function isGitShowCommitOutput(text: string): boolean {
   return text.split('\n').some((line) => SHOW_COMMIT_HEADER_LINE_REGEX.test(line));
}

/**
 * Builds the enhanced `gdx show` preamble from the raw git-show header.
 * @param options - Preamble source lines plus optional relative ref and file stats.
 * @returns Preamble lines for the diff viewer.
 */
export function buildShowPreamble(options: {
   preamble: string[];
   relativeRef?: string;
   stat?: string;
}): string[] {
   const { relativeRef, stat } = options;
   const lines = options.preamble.slice();
   const commitLineIndex = lines.findIndex((line) => /^commit [0-9a-f]{7,40}\b/i.test(line));

   if (relativeRef && commitLineIndex !== -1 && !lines[commitLineIndex].includes(relativeRef)) {
      lines[commitLineIndex] = `Commit:${lines[commitLineIndex].slice(6)} (${relativeRef})`;
   }

   while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
   }

   const trimmedStat = stat?.trimEnd();
   if (trimmedStat) {
      lines.push('');
      lines.push(...trimmedStat.split('\n'));
   }

   return lines;
}

/**
 * Adds enhanced metadata to the raw git-show output before it reaches the diff viewer.
 * @param diffText - Raw git show output.
 * @param options - Optional relative ref and file stats to append.
 * @returns Enriched show output.
 */
export function buildEnhancedShowDiffText(
   diffText: string,
   options: { relativeRef?: string; stat?: string }
): string {
   const { body, preamble } = separateShowPreamble(diffText);
   if (preamble.length === 0) return diffText;

   const preambleLines = buildShowPreamble({
      preamble,
      relativeRef: options.relativeRef,
      stat: options.stat,
   });
   return [...preambleLines, '', body].join('\n');
}

/**
 * Finds the adjacent commit in the current show navigation scope.
 * @param git$ - Git executable/context from GdxContext.
 * @param currentCommit - Full hash for the currently displayed commit.
 * @param plan - Parsed navigation plan.
 * @param direction - Whether to seek to an older or newer commit.
 * @returns The adjacent commit hash, or null when no adjacent commit exists.
 */
async function findAdjacentShowCommit(
   git$: GdxContext['git$'],
   currentCommit: string,
   plan: ShowCommitNavigationPlan,
   direction: 'previous' | 'next'
): Promise<string | null> {
   const adjacentCommits = await findAdjacentShowCommits(git$, currentCommit, plan);
   return adjacentCommits[direction];
}

/**
 * Finds both adjacent commits in the current show navigation scope.
 * @param git$ - Git executable/context from GdxContext.
 * @param currentCommit - Full hash for the currently displayed commit.
 * @param plan - Parsed navigation plan.
 * @returns Older and newer adjacent commit hashes when available.
 */
export async function findAdjacentShowCommits(
   git$: GdxContext['git$'],
   currentCommit: string,
   plan: ShowCommitNavigationPlan
): Promise<ShowCommitAdjacentCommits> {
   const result = await $`${git$} log --format=%H ${plan.navigationArgs}`;
   const commits = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
   const currentIndex = commits.indexOf(currentCommit);
   if (currentIndex !== -1) {
      return {
         previous: commits[currentIndex + 1] ?? null,
         next: commits[currentIndex - 1] ?? null,
      };
   }

   const pathspecIndex = plan.navigationArgs.indexOf('--');
   if (pathspecIndex === -1) return { previous: null, next: null };

   const historyArgs = plan.navigationArgs.slice(0, pathspecIndex);
   const historyResult = await $`${git$} log --format=%H ${historyArgs}`;
   const historyCommits = historyResult.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
   const historyIndex = historyCommits.indexOf(currentCommit);
   if (historyIndex === -1) return { previous: null, next: null };

   const commitIndex = new Map(historyCommits.map((commit, index) => [commit, index]));
   let previous: string | null = null;
   let next: string | null = null;
   let previousDistance = Number.POSITIVE_INFINITY;
   let nextDistance = Number.POSITIVE_INFINITY;

   for (const commit of commits) {
      const index = commitIndex.get(commit);
      if (index === undefined) continue;

      if (index > historyIndex && index - historyIndex < previousDistance) {
         previous = commit;
         previousDistance = index - historyIndex;
      }

      if (index < historyIndex && historyIndex - index < nextDistance) {
         next = commit;
         nextDistance = historyIndex - index;
      }
   }

   return { previous, next };
}

/**
 * Builds pager actions for commit navigation, omitting directions that cannot be used.
 * @param adjacentCommits - Adjacent commits available from the current show target.
 * @returns Pager actions for available navigation directions.
 */
export function buildShowCommitNavigationActions(
   adjacentCommits: ShowCommitAdjacentCommits
): PagerAction[] {
   const actions: PagerAction[] = [];

   if (adjacentCommits.previous) {
      actions.push({
         key: LEFT_ARROW_KEY,
         displayKey: '←',
         label: 'previous',
         action: SHOW_PREVIOUS_COMMIT_ACTION,
      });
   }

   if (adjacentCommits.next) {
      actions.push({
         key: RIGHT_ARROW_KEY,
         displayKey: '→',
         label: 'next',
         action: SHOW_NEXT_COMMIT_ACTION,
      });
   }

   return actions;
}

/**
 * Syntax-highlights file content for display in the plain show pager.
 * @param content - Raw file content from git-show.
 * @param path - Repository path used for language detection.
 * @returns ANSI-highlighted content, or the raw content if highlighting fails.
 */
async function highlightShowBlobContent(content: string, path: string): Promise<string> {
   const ext = path.split('.').pop()?.toLowerCase() || '';
   const lang = EXTENSION_LANG_MAP[ext] || 'text';

   try {
      const shiki = await import('@shikijs/cli');
      return await shiki.codeToANSI(content, lang as never, TUI_THEME as never);
   } catch {
      return content;
   }
}

/**
 * Loads and displays a non-diff `git show <revision>:<path>` blob.
 * @param ctx - Current GDX context.
 * @param showArgs - Arguments passed after `gdx show`.
 * @param plan - Parsed blob navigation plan.
 * @param commit - Commit hash or ref to display.
 * @param showLoading - Whether to clear the screen and show a loading spinner first.
 * @param preloadedContent - Already-loaded content to avoid re-running the first request.
 * @returns The pager action selected by the user.
 */
async function viewShowBlob(
   ctx: GdxContext,
   showArgs: string[],
   plan: ShowBlobNavigationPlan,
   commit: string,
   showLoading: boolean,
   preloadedContent?: string
) {
   if (showLoading) clearInteractiveScreen();
   const spinnerCtrl =
      showLoading || preloadedContent === undefined
         ? spinner({
            message: 'Loading file...',
         })
         : undefined;

   try {
      const content =
         preloadedContent ??
         (
            await $`${ctx.git$} -c color.ui=never show ${buildShowBlobArgsForCommit(
               showArgs,
               plan,
               commit
            )}`
         ).stdout;
      const [relativeRef, highlightedContent, adjacentCommits] = plan.isIndexStage
         ? [
            'index',
            await highlightShowBlobContent(content, plan.path),
            { previous: null, next: null },
         ]
         : await Promise.all([
            resolveHeadRelativeCommitRef(ctx.git$, commit, false),
            highlightShowBlobContent(content, plan.path),
            findAdjacentShowCommits(ctx.git$, commit, plan),
         ]);
      spinnerCtrl?.stop();

      return await pager(highlightedContent, {
         showLineNumbers: true,
         lineNumberWidth: Math.max(4, String(content.split('\n').length).length),
         statusText: `${strLimit(plan.path, 40, 'mid', -1)}@${relativeRef || commit.slice(0, 7)}`,
         actions: buildShowCommitNavigationActions(adjacentCommits),
      });
   } catch (e) {
      spinnerCtrl?.stop();
      throw e;
   }
}

/**
 * Loads and displays the enhanced `git show` viewer, returning pager actions for commit seeking.
 * @param ctx - Current GDX context.
 * @param showArgs - Arguments passed after `gdx show`.
 * @param plan - Parsed navigation plan.
 * @param commit - Commit hash or ref to display.
 * @param showLoading - Whether to clear the screen and show a loading spinner first.
 * @param preloadedDiffText - Already-loaded show output to avoid re-running the first request.
 * @returns The pager action selected by the user.
 */
async function viewShowCommit(
   ctx: GdxContext,
   showArgs: string[],
   plan: ShowCommitNavigationPlan,
   commit: string,
   showLoading: boolean,
   preloadedDiffText?: string
) {
   if (showLoading) clearInteractiveScreen();
   const spinnerCtrl =
      showLoading && preloadedDiffText === undefined
         ? spinner({
            message: 'Loading commit...',
         })
         : undefined;

   try {
      const diffText =
         preloadedDiffText ??
         (
            await $`${ctx.git$} -c color.ui=never show ${buildShowArgsForCommit(
               showArgs,
               plan,
               commit
            )}`
         ).stdout;
      const [relativeRef, stat, adjacentCommits] = await Promise.all([
         resolveHeadRelativeCommitRef(ctx.git$, commit, false),
         getShowCommitStat(ctx.git$, showArgs, plan, commit),
         findAdjacentShowCommits(ctx.git$, commit, plan),
      ]);
      spinnerCtrl?.stop();

      if (!diffText || (!isGitDiffOutput(diffText) && !isGitShowCommitOutput(diffText))) {
         return undefined;
      }

      return await viewDiff(buildEnhancedShowDiffText(diffText, { relativeRef, stat }), {
         actions: buildShowCommitNavigationActions(adjacentCommits),
         git$: ctx.git$,
         highlighting: {
            oldRevision: `${commit}^`,
            newRevision: commit,
         },
      });
   } catch (e) {
      spinnerCtrl?.stop();
      throw e;
   }
}

/**
 * Runs the enhanced interactive `gdx show` session with previous/next commit seeking.
 * @param ctx - Current GDX context.
 * @param showArgs - Arguments passed after `gdx show`.
 * @param initialDiffText - Already-loaded show output for the initial commit.
 */
export async function viewInteractiveShow(
   ctx: GdxContext,
   showArgs: string[],
   initialDiffText?: string
): Promise<void> {
   const plan = buildShowCommitNavigationPlan(showArgs);
   let currentCommit = await resolveShowCommit(ctx.git$, plan.targetRef);
   let action = await viewShowCommit(ctx, showArgs, plan, currentCommit, false, initialDiffText);

   while (
      action?.action === SHOW_PREVIOUS_COMMIT_ACTION ||
      action?.action === SHOW_NEXT_COMMIT_ACTION
   ) {
      process.stdout.write('\x1b[H');
      process.stdout.clearScreenDown();
      const direction = action.action === SHOW_PREVIOUS_COMMIT_ACTION ? 'previous' : 'next';
      const adjacentCommit = await findAdjacentShowCommit(ctx.git$, currentCommit, plan, direction);
      if (!adjacentCommit) {
         Logger.warn('Attempted to navigate beyond available commits, but no adjacent commit was found. This is unexpected since navigation actions should have been disabled. Reloading current commit as fallback.', 'show-navigation');
         action = await viewShowCommit(ctx, showArgs, plan, currentCommit, true);
         continue;
      }

      currentCommit = adjacentCommit;
      action = await viewShowCommit(ctx, showArgs, plan, currentCommit, true);
   }
}

/**
 * Runs the enhanced interactive blob viewer for `gdx show <revision>:<path>`.
 * @param ctx - Current GDX context.
 * @param showArgs - Arguments passed after `gdx show`.
 * @param plan - Parsed blob navigation plan.
 * @param initialContent - Already-loaded blob output for the initial commit.
 */
export async function viewInteractiveShowBlob(
   ctx: GdxContext,
   showArgs: string[],
   plan: ShowBlobNavigationPlan,
   initialContent?: string
): Promise<void> {
   if (plan.isIndexStage) {
      await viewShowBlob(ctx, showArgs, plan, '', false, initialContent);
      return;
   }

   let currentCommit = await resolveShowCommit(ctx.git$, plan.targetRef);
   let action = await viewShowBlob(ctx, showArgs, plan, currentCommit, false, initialContent);

   while (
      action?.action === SHOW_PREVIOUS_COMMIT_ACTION ||
      action?.action === SHOW_NEXT_COMMIT_ACTION
   ) {
      process.stdout.write('\x1b[H');
      process.stdout.clearScreenDown();
      const direction = action.action === SHOW_PREVIOUS_COMMIT_ACTION ? 'previous' : 'next';
      const adjacentCommit = await findAdjacentShowCommit(ctx.git$, currentCommit, plan, direction);
      if (!adjacentCommit) {
         Logger.warn('Attempted to navigate beyond available commits, but no adjacent commit was found. This is unexpected since navigation actions should have been disabled. Reloading current commit as fallback.', 'show-navigation');
         action = await viewShowBlob(ctx, showArgs, plan, currentCommit, true);
         continue;
      }

      currentCommit = adjacentCommit;
      action = await viewShowBlob(ctx, showArgs, plan, currentCommit, true);
   }
}

export default {
   viewInteractiveShow,
   viewInteractiveShowBlob,
};
