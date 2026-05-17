import { ncc } from '@lib/Tools';

import { GdxContext } from '@/common/types';
import { isGitDiffOutput, viewDiff } from '@/modules/diff-viewer';
import { $, spinner } from '@/modules/shell';
import { fgRgb } from './graphics';
import { CATPPUCCIN_VPALETTE } from '@/consts';
import { resolveHeadRelativeCommitRef, revParseCached } from './git';

const DIFF_HEADER_LINE_REGEX = /^diff --(git|cc|combined)\b/;
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
]);

export interface ShowCommitNavigationPlan {
   targetRef: string;
   targetIndex: number | null;
   navigationArgs: string[];
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
   return (
      await $`${git$} -c color.ui=never show --stat --format= ${buildShowArgsForCommit(
         showArgs,
         plan,
         commit
      )}`
   ).stdout
      .trimEnd()
      .replace(/(\W)(\++)/g, `$1${ncc('Green')}$2${fgRgb(CATPPUCCIN_VPALETTE.overlay0)}`)
      .replace(/(-+)/g, `${ncc('Red')}$1${fgRgb(CATPPUCCIN_VPALETTE.overlay0)}`);
}

/**
 * Splits a git-show output into its preamble and diff body.
 * @param diffText - Raw git show output.
 * @returns Preamble lines and diff body.
 */
export function separateShowPreamble(diffText: string): { body: string; preamble: string[] } {
   const lines = diffText.split('\n');
   const firstDiffIndex = lines.findIndex((line) => DIFF_HEADER_LINE_REGEX.test(line));
   if (firstDiffIndex === -1) return { body: diffText, preamble: [] };
   return {
      body: lines.slice(firstDiffIndex).join('\n'),
      preamble: lines.slice(0, firstDiffIndex),
   };
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
   const result = await $`${git$} log --format=%H ${plan.navigationArgs}`;
   const commits = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
   const currentIndex = commits.indexOf(currentCommit);
   if (currentIndex === -1) return null;

   const nextIndex = direction === 'previous' ? currentIndex + 1 : currentIndex - 1;
   return commits[nextIndex] ?? null;
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
      const [relativeRef, stat] = await Promise.all([
         resolveHeadRelativeCommitRef(ctx.git$, commit, false),
         getShowCommitStat(ctx.git$, showArgs, plan, commit),
      ]);
      spinnerCtrl?.stop();

      if (!diffText || !isGitDiffOutput(diffText)) return undefined;

      return await viewDiff(buildEnhancedShowDiffText(diffText, { relativeRef, stat }), {
         actions: [
            {
               key: LEFT_ARROW_KEY,
               displayKey: '←',
               label: 'previous',
               action: SHOW_PREVIOUS_COMMIT_ACTION,
            },
            {
               key: RIGHT_ARROW_KEY,
               displayKey: '→',
               label: 'next',
               action: SHOW_NEXT_COMMIT_ACTION,
            },
         ],
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
 * Runs the enhanced interactive `gdx show` session with left/right commit seeking.
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
      const direction = action.action === SHOW_PREVIOUS_COMMIT_ACTION ? 'previous' : 'next';
      const adjacentCommit = await findAdjacentShowCommit(ctx.git$, currentCommit, plan, direction);
      if (!adjacentCommit) {
         action = await viewShowCommit(ctx, showArgs, plan, currentCommit, true);
         continue;
      }

      currentCommit = adjacentCommit;
      action = await viewShowCommit(ctx, showArgs, plan, currentCommit, true);
   }
}

export default {
   viewInteractiveShow,
};
