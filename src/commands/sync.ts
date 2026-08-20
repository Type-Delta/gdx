import { CommandHelpObj, CommandStructure, GdxContext } from '@/common/types';
import { EXECUTABLE_NAME, SGR } from '@/consts';
import {
   assertInGitWorktree,
   getTrackedUpstreamDetails,
   revParseCached,
} from '@/modules/git';
import { ArgsSet } from '@/modules/arguments';
import { $, execGit } from '@/modules/shell';
import Logger from '@/utils/logger';
import { mergeIntoTarget } from './merge';

/**
 * Pulls the current branch and pushes it when the pull succeeds.
 * With `--target`, the pull is merged into the named local branch using the
 * same worktree routing and conflict retention as `gdx merge --target`.
 * @param ctx Command context containing Git executable and arguments.
 * @returns Exit code from the first failed operation, or zero on success.
 */
export default async function sync(ctx: GdxContext): Promise<number> {
   if (!(await assertInGitWorktree(ctx.git$))) return 1;

   const syncArgs = ctx.args.slice(1);
   let targetBranch: string | null;
   try {
      targetBranch = syncArgs.popAssertValue('--target');
   } catch (err) {
      Logger.error(String(err), 'sync');
      return 1;
   }

   if (syncArgs.length > 0) {
      Logger.error(`Unknown sync option '${syncArgs[0]}'.`, 'sync');
      return 1;
   }

   const currentBranch = (await revParseCached(ctx.git$, ['--abbrev-ref', 'HEAD'])).trim();
   if (!targetBranch || targetBranch === currentBranch) return syncCurrentBranch(ctx);
   return syncTargetBranch(ctx, targetBranch);
}

/**
 * Pulls and then pushes the branch in the current worktree.
 * @param ctx Command context.
 * @returns Exit code from pull or push.
 */
async function syncCurrentBranch(ctx: GdxContext): Promise<number> {
   const pullResult = await execGit(ctx.git$, ['pull']);
   if (pullResult !== 0) return pullResult;
   return execGit(ctx.git$, ['push']);
}

/**
 * Fetches a target branch's upstream, merges it through the existing target
 * merge implementation, then pushes the target branch explicitly.
 * @param ctx Command context.
 * @param targetBranch Local branch to synchronize.
 * @returns Exit code from fetch, merge, or push.
 */
async function syncTargetBranch(ctx: GdxContext, targetBranch: string): Promise<number> {
   const upstream = await getTrackedUpstreamDetails(ctx.git$, targetBranch);
   if (!upstream) {
      Logger.error(`Target branch '${targetBranch}' has no configured upstream branch.`, 'sync');
      return 1;
   }

   const fetchResult = await execGit(ctx.git$, ['fetch', upstream.remote, upstream.mergeRef]);
   if (fetchResult !== 0) return fetchResult;

   let fetchedSha = '';
   try {
      fetchedSha = (await $`${ctx.git$} rev-parse --verify FETCH_HEAD^{commit}`).stdout.trim();
   } catch {
      // The fetch succeeded, but did not produce a usable commit for the configured ref.
   }
   if (!fetchedSha) {
      Logger.error(`Could not resolve the fetched upstream for '${targetBranch}'.`, 'sync');
      return 1;
   }

   const mergeResult = await mergeIntoTarget(ctx, targetBranch, new ArgsSet([fetchedSha]));
   if (mergeResult !== 0) return mergeResult;

   return execGit(ctx.git$, [
      'push',
      upstream.remote,
      `refs/heads/${targetBranch}:${upstream.mergeRef}`,
   ]);
}

export const help = {
   long: () =>
      `Pulls the current branch and pushes it after a successful pull. With ${SGR.cyan}--target <branch>${SGR.reset}, synchronizes that branch against its own upstream without checking it out first.`,
   short: 'Pull, then push the current branch or a target branch.',
   usage: () =>
      [
         `${SGR.cyan}${EXECUTABLE_NAME} sync${SGR.reset}`,
         `${SGR.cyan}${EXECUTABLE_NAME} sync --target${SGR.reset} ${SGR.dim}<branch>${SGR.reset}`,
      ].join('\n'),
} as const satisfies CommandHelpObj;

export const structure = {
   $root: ['--target'],
} as const satisfies CommandStructure;
