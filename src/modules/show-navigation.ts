import { GdxContext } from '@/common/types';
import { isGitDiffOutput, viewDiff } from '@/modules/diff-viewer';
import { $, spinner } from '@/modules/shell';

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
   return (await $`${git$} rev-parse --verify ${`${ref}^{commit}`}`).stdout.trim();
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
            interval: 10,
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
      spinnerCtrl?.stop();
      if (!diffText || !isGitDiffOutput(diffText)) return undefined;
      return await viewDiff(diffText, {
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
