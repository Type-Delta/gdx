import { ExecaError } from 'execa';
import litedent from 'litedent';
import path from 'path';

import { yuString } from '@lib/Tools';

import { CommandHelpObj, CommandStructure, GdxContext } from '@/common/types';
import { EXECUTABLE_NAME, SGR } from '@/consts';
import {
   assertInGitWorktree,
   forceColorArgs,
   getWorktreeList,
   getWorktreeOperations,
   invalidateWorktreeListCache,
   resolveRefShaCached,
   revParseCached,
} from '@/modules/git';
import { $, execGit } from '@/modules/shell';
import { ArgsSet } from '@/modules/arguments';
import {
   createRegisteredParallelWorktree,
   getParallelMetadata,
   removeParallelWorktree,
} from '@/commands/parallel';
import Logger from '@/utils/logger';
import { normalizePath, quickPrint } from '@/utils/utilities';

const MERGE_VALUE_OPTIONS = new Set([
   '-m',
   '--message',
   '-F',
   '--file',
   '-s',
   '--strategy',
   '-X',
   '--strategy-option',
   '-S',
   '--gpg-sign',
]);

const MERGE_VALUE_OPTION_PREFIXES = [
   '--message=',
   '--file=',
   '--strategy=',
   '--strategy-option=',
   '--gpg-sign=',
];

/**
 * Runs the merge command, including GDX's target-branch extension.
 * @param ctx Command context containing git executable and arguments.
 * @returns Exit code.
 */
export default async function merge(ctx: GdxContext): Promise<number> {
   if (!(await assertInGitWorktree(ctx.git$))) return 1;

   const args = ctx.args;
   const mergeArgs = args.slice(1);

   let targetBranch: string | null;
   try {
      targetBranch = mergeArgs.popAssertValue('--target');
   } catch (err) {
      Logger.error(String(err), 'merge');
      return 1;
   }

   if (targetBranch) {
      if (mergeArgs.length === 0) {
         Logger.error(
            '`merge --target` requires merge arguments to apply to the target branch.',
            'merge'
         );
         return 1;
      }

      return mergeIntoTarget(ctx, targetBranch, mergeArgs);
   }

   if (isMergeCleanup(mergeArgs)) {
      return runMergeCleanup(ctx, new ArgsSet(['merge', ...mergeArgs]));
   }

   return execGit(ctx.git$, args);
}

/**
 * Checks whether the merge invocation is a cleanup operation.
 * @param mergeArgs Arguments after the `merge` command.
 * @returns True when this is merge continue or abort.
 */
function isMergeCleanup(mergeArgs: ArgsSet): boolean {
   return mergeArgs.hasOption('--continue') || mergeArgs.hasOption('--abort');
}

/**
 * Runs git merge cleanup and removes merge-created temporary worktrees on success.
 * @param ctx Command context.
 * @param args Full normalized git merge args.
 * @returns Exit code.
 */
async function runMergeCleanup(ctx: GdxContext, args: ArgsSet): Promise<number> {
   const repoRoot = (await revParseCached(ctx.git$, ['--show-toplevel'])).trim();
   const meta = repoRoot ? getParallelMetadata(repoRoot) : null;
   const exitCode = await execGit(ctx.git$, args);

   if (exitCode !== 0 || meta?.purpose !== 'merge-target') {
      return exitCode;
   }

   const removeResult = await removeParallelWorktree(ctx.git$, meta.alias, {
      chdirToOrigin: true,
   });
   if (removeResult === 0 && meta.originPath) {
      ctx.repository = {
         root: path.resolve(meta.originPath),
         gitDir: path.resolve(meta.originPath, '.git'),
         commonGitDir: path.resolve(meta.originPath, '.git'),
      };
   }
   return removeResult === 0 ? 0 : removeResult;
}

/**
 * Merges the supplied merge arguments into a target branch.
 * @param ctx Command context.
 * @param targetBranch Local branch to merge into.
 * @param mergeArgs Git merge arguments without `--target`.
 * @returns Exit code.
 */
export async function mergeIntoTarget(
   ctx: GdxContext,
   targetBranch: string,
   mergeArgs: ArgsSet
): Promise<number> {
   const targetSha = await resolveRefShaCached(ctx.git$, `refs/heads/${targetBranch}`, {
      type: 'commit',
   });
   if (!targetSha) {
      Logger.error(`Target branch '${targetBranch}' was not found.`, 'merge');
      return 1;
   }

   const currentBranch = (await revParseCached(ctx.git$, ['--abbrev-ref', 'HEAD'])).trim();
   if (currentBranch === targetBranch) {
      return execGit(ctx.git$, new ArgsSet(['merge', ...mergeArgs]));
   }

   const currentRoot = (await revParseCached(ctx.git$, ['--show-toplevel'])).trim();
   if (isMergeCleanup(mergeArgs)) {
      await invalidateWorktreeListCache(ctx.git$);
   }
   const checkedOut = await findCheckedOutBranch(ctx, targetBranch);
   if (checkedOut && !samePath(checkedOut.path, currentRoot)) {
      return runMergeInExistingWorktree(ctx, checkedOut.path, mergeArgs);
   }

   const sourceRef = getSingleMergeSource(mergeArgs);
   const canTryFastForward = sourceRef && canUseDirectFastForward(mergeArgs, sourceRef);
   if (canTryFastForward) {
      const sourceSha = await resolveRefShaCached(ctx.git$, sourceRef, { type: 'commit' });
      if (!sourceSha) {
         Logger.error(`Merge source '${sourceRef}' was not found.`, 'merge');
         return 1;
      }

      if (
         !(await isAnnotatedTag(ctx.git$, sourceRef)) &&
         (await isAncestor(ctx.git$, targetSha, sourceSha))
      ) {
         await fastForwardBranch(ctx, targetBranch, targetSha, sourceSha, sourceRef);
         quickPrint(
            `${SGR.cyan}Fast-forwarded '${targetBranch}'${SGR.reset} to ${sourceSha.slice(0, 12)}`
         );
         return 0;
      }
   }

   return mergeInRegisteredWorktree(ctx, targetBranch, targetSha, mergeArgs);
}

/**
 * Runs the merge command in an existing worktree that already has the target branch checked out.
 * @param ctx Command context to retarget for command execution and audit metadata.
 * @param worktreePath Existing worktree path.
 * @param mergeArgs Git merge arguments without `merge` or `--target`.
 * @returns Exit code.
 */
async function runMergeInExistingWorktree(
   ctx: GdxContext,
   worktreePath: string,
   mergeArgs: ArgsSet
): Promise<number> {
   const gitExec = Array.isArray(ctx.git$) ? ctx.git$[0] : ctx.git$;
   const worktreeGit$ = [gitExec, '-C', worktreePath];
   const meta = getParallelMetadata(worktreePath);
   ctx.repository = {
      root: path.resolve(worktreePath),
      gitDir: path.resolve(worktreePath, '.git'),
      commonGitDir: path.resolve(worktreePath, '.git'),
   };

   const exitCode = await execGit(worktreeGit$, new ArgsSet(['merge', ...mergeArgs]));
   if (exitCode !== 0 || !isMergeCleanup(mergeArgs) || meta?.purpose !== 'merge-target') {
      return exitCode;
   }

   const removeResult = await removeParallelWorktree(worktreeGit$, meta.alias, {
      chdirToOrigin: true,
   });
   if (removeResult === 0 && meta.originPath) {
      ctx.repository = {
         root: path.resolve(meta.originPath),
         gitDir: path.resolve(meta.originPath, '.git'),
         commonGitDir: path.resolve(meta.originPath, '.git'),
      };
   }
   return removeResult === 0 ? 0 : removeResult;
}

/**
 * Finds a worktree currently checking out the given local branch.
 * @param ctx Command context.
 * @param branch Local branch name.
 * @returns Worktree entry or null.
 */
async function findCheckedOutBranch(
   ctx: GdxContext,
   branch: string
): Promise<{ path: string } | null> {
   const branchRef = `refs/heads/${branch}`;
   const worktrees = await getWorktreeList(ctx.git$);
   return worktrees.find((worktree) => worktree.branch === branchRef) ?? null;
}

/**
 * Checks path equality with Windows case-insensitivity.
 * @param left First path.
 * @param right Second path.
 * @returns True if both paths identify the same location.
 */
function samePath(left: string, right: string): boolean {
   const resolvedLeft = path.resolve(left);
   const resolvedRight = path.resolve(right);
   if (process.platform === 'win32') {
      return resolvedLeft.toLowerCase() === resolvedRight.toLowerCase();
   }
   return resolvedLeft === resolvedRight;
}

/**
 * Returns the single merge source when the args are simple enough to fast-forward directly.
 * @param mergeArgs Git merge args without `merge`.
 * @returns Source ref or null.
 */
function getSingleMergeSource(mergeArgs: ArgsSet): string | null {
   const sources: string[] = [];

   for (let index = 0; index < mergeArgs.length; index++) {
      const arg = mergeArgs[index];
      if (arg === '--') break;

      if (MERGE_VALUE_OPTIONS.has(arg)) {
         index++;
         continue;
      }

      if (MERGE_VALUE_OPTION_PREFIXES.some((prefix) => arg.startsWith(prefix))) {
         continue;
      }

      if (arg.startsWith('-')) continue;
      sources.push(arg);
   }

   return sources.length === 1 ? sources[0] : null;
}

/**
 * Checks whether the invocation is a plain, single-source merge whose fast-forward
 * behavior can be represented by an atomic ref update. Any option is delegated to
 * Git so validation, signatures, output controls, and other semantics are preserved.
 * @param mergeArgs Git merge args without `merge`.
 * @param sourceRef Parsed single merge source.
 * @returns True if direct ref update is equivalent to `merge --ff-only`.
 */
function canUseDirectFastForward(mergeArgs: ArgsSet, sourceRef: string): boolean {
   return mergeArgs.length === 1 && mergeArgs[0] === sourceRef;
}

/**
 * Checks whether a merge source names an annotated tag. Annotated tags can require
 * Git-specific merge behavior and therefore must not use the direct ref-update path.
 * @param git$ Git executable or scoped command array.
 * @param sourceRef User supplied merge source.
 * @returns True when the source resolves to a tag object.
 */
async function isAnnotatedTag(git$: GdxContext['git$'], sourceRef: string): Promise<boolean> {
   try {
      const result = await $`${git$} cat-file -t ${sourceRef}`;
      return result.stdout.trim() === 'tag';
   } catch {
      return false;
   }
}

/**
 * Checks whether one commit is an ancestor of another.
 * @param git$ Git executable or scoped command array.
 * @param ancestor Commit expected to be an ancestor.
 * @param descendant Commit expected to be a descendant.
 * @returns True when ancestor is reachable from descendant.
 */
async function isAncestor(
   git$: GdxContext['git$'],
   ancestor: string,
   descendant: string
): Promise<boolean> {
   try {
      await $`${git$} merge-base --is-ancestor ${ancestor} ${descendant}`;
      return true;
   } catch {
      return false;
   }
}

/**
 * Moves a local branch through an atomic fast-forward update.
 * @param ctx Command context.
 * @param targetBranch Local branch to update.
 * @param oldSha Expected old target SHA.
 * @param newSha New target SHA.
 * @param sourceRef User supplied source ref.
 */
async function fastForwardBranch(
   ctx: GdxContext,
   targetBranch: string,
   oldSha: string,
   newSha: string,
   sourceRef: string
): Promise<void> {
   await $`${ctx.git$} update-ref -m ${`merge ${sourceRef}: Fast-forward`} ${`refs/heads/${targetBranch}`} ${newSha} ${oldSha}`;
   await invalidateWorktreeListCache(ctx.git$);
}

/**
 * Runs a non-fast-forward merge in a registered temporary worktree.
 * @param ctx Command context.
 * @param targetBranch Local branch to check out in the temporary worktree.
 * @param targetSha Current target branch SHA.
 * @param mergeArgs Git merge args without `merge`.
 * @returns Exit code.
 */
async function mergeInRegisteredWorktree(
   ctx: GdxContext,
   targetBranch: string,
   targetSha: string,
   mergeArgs: ArgsSet
): Promise<number> {
   const alias = createMergeAlias(targetBranch);
   let created: Awaited<ReturnType<typeof createRegisteredParallelWorktree>>;

   try {
      created = await createRegisteredParallelWorktree(ctx.git$, {
         alias,
         branch: targetBranch,
         baseCommit: targetSha,
         purpose: 'merge-target',
         targetBranch,
         mergeArgs: mergeArgs.toArray(),
      });
   } catch (err) {
      Logger.error(`Failed to create merge worktree. ${errorMessage(err)}`, 'merge');
      Logger.debug(yuString(err, { color: true }), 'merge');
      return 1;
   }

   const gitExec = Array.isArray(ctx.git$) ? ctx.git$[0] : ctx.git$;
   const worktreeGit$ = [gitExec, '-C', created.path];

   try {
      const result = await $`${gitExec} ${forceColorArgs()} -C ${created.path} merge ${mergeArgs}`;
      printGitResult(result);

      const operations = await getWorktreeOperations(worktreeGit$, created.path);
      if (operations.includes('merge')) {
         printPendingMergeHelp(alias, created.path);
         return 0;
      }

      const status = (
         await $`${gitExec} -C ${created.path} status --porcelain=v1 --untracked-files=normal`
      ).stdout.trim();
      if (status) {
         printPendingChangesHelp(alias, created.path);
         return 0;
      }

      const removeResult = await removeParallelWorktree(worktreeGit$, alias, {
         chdirToOrigin: true,
      });
      return removeResult === 0 ? 0 : removeResult;
   } catch (err) {
      printGitResult(getGitErrorOutput(err));

      const operations = await getWorktreeOperations(worktreeGit$, created.path);
      if (operations.includes('merge')) {
         printConflictHelp(alias, created.path);
         return getExitCode(err);
      }

      await removeParallelWorktree(worktreeGit$, alias, { chdirToOrigin: true });
      return getExitCode(err);
   }
}

/**
 * Creates a parallel alias for merge-target worktrees.
 * @param targetBranch Target branch name.
 * @returns Safe alias.
 */
function createMergeAlias(targetBranch: string): string {
   const safeTarget = normalizePath(targetBranch).replace(/[^A-Za-z0-9._-]/g, '_');
   return `merge-${safeTarget.slice(0, 36)}-${Date.now().toString(36)}`;
}

/**
 * Prints manual conflict recovery instructions.
 * @param alias Parallel worktree alias.
 * @param worktreePath Created worktree path.
 */
function printConflictHelp(alias: string, worktreePath: string): void {
   const switchCommand = `${EXECUTABLE_NAME} parallel switch ${alias}`;
   quickPrint('');
   quickPrint(`${SGR.yellow}Merge conflicts were left in:${SGR.reset} ${worktreePath}`);
   quickPrint(
      `${SGR.yellow}To resolve them, run:${SGR.reset} ${SGR.cyan}${switchCommand}${SGR.reset}`
   );
   quickPrint(
      `${SGR.dim}Then run ${EXECUTABLE_NAME} merge --continue, or discard with ${EXECUTABLE_NAME} merge --abort / ${EXECUTABLE_NAME} parallel remove ${alias}.${SGR.reset}`
   );
}

/**
 * Prints instructions for completing a successful merge stopped before commit.
 * @param alias Parallel worktree alias.
 * @param worktreePath Created worktree path.
 */
function printPendingMergeHelp(alias: string, worktreePath: string): void {
   quickPrint('');
   quickPrint(`${SGR.yellow}Merge is ready to commit in:${SGR.reset} ${worktreePath}`);
   quickPrint(
      `${SGR.yellow}To finish it, run:${SGR.reset} ${SGR.cyan}${EXECUTABLE_NAME} parallel switch ${alias}${SGR.reset}`
   );
   quickPrint(
      `${SGR.dim}Then run ${EXECUTABLE_NAME} merge --continue, or discard with ${EXECUTABLE_NAME} merge --abort.${SGR.reset}`
   );
}

/**
 * Prints instructions for successful merge modes that intentionally leave changes
 * for the user to commit, such as `--squash`.
 * @param alias Parallel worktree alias.
 * @param worktreePath Created worktree path.
 */
function printPendingChangesHelp(alias: string, worktreePath: string): void {
   quickPrint('');
   quickPrint(`${SGR.yellow}Merged changes are ready in:${SGR.reset} ${worktreePath}`);
   quickPrint(
      `${SGR.yellow}To review and commit them, run:${SGR.reset} ${SGR.cyan}${EXECUTABLE_NAME} parallel switch ${alias}${SGR.reset}`
   );
   quickPrint(
      `${SGR.dim}After committing, remove the temporary worktree with ${EXECUTABLE_NAME} parallel remove ${alias}.${SGR.reset}`
   );
}

/**
 * Formats process output as text.
 * @param output Execa output value.
 * @returns Text output.
 */
function formatGitOutput(output: unknown): string {
   if (!output) return '';
   if (typeof output === 'string') return output;
   if (output instanceof Uint8Array) return new TextDecoder().decode(output);
   return String(output);
}

/**
 * Prints stdout and stderr from a git result.
 * @param result Object containing stdout and stderr.
 */
function printGitResult(result: { stdout?: unknown; stderr?: unknown }): void {
   for (const output of [result.stdout, result.stderr]) {
      const text = formatGitOutput(output);
      if (text) quickPrint(text, text.endsWith('\n') ? '' : '\n');
   }
}

/**
 * Extracts stdout and stderr from a git error.
 * @param err Unknown error.
 * @returns Output object.
 */
function getGitErrorOutput(err: unknown): { stdout?: unknown; stderr?: unknown } {
   if (err instanceof ExecaError) {
      return { stdout: err.stdout, stderr: err.stderr };
   }
   const typedErr = err as { stdout?: unknown; stderr?: unknown } | null;
   return { stdout: typedErr?.stdout, stderr: typedErr?.stderr };
}

/**
 * Extracts an exit code from a failed command.
 * @param err Unknown error.
 * @returns Exit code.
 */
function getExitCode(err: unknown): number {
   const typedErr = err as { exitCode?: number } | null;
   return typedErr?.exitCode ?? 1;
}

/**
 * Converts an unknown error to a short message.
 * @param err Unknown error.
 * @returns Error message.
 */
function errorMessage(err: unknown): string {
   return err instanceof Error ? err.message : String(err);
}

export const help = {
   long: () =>
      `Extends git merge with ${SGR.cyan}--target <branch>${SGR.reset} for merging into a local branch without checking it out first.`,
   short: 'Merge into the current branch or a target branch.',
   usage: () => litedent`
   ${SGR.cyan}${EXECUTABLE_NAME} merge ${SGR.dim}<git-merge-args>${SGR.reset}
   ${SGR.cyan}${EXECUTABLE_NAME} merge ${SGR.dim}<source>${SGR.reset} ${SGR.cyan}--target${SGR.reset} ${SGR.dim}<branch>${SGR.reset}
   ${SGR.cyan}${EXECUTABLE_NAME} merge --continue${SGR.reset}
   ${SGR.cyan}${EXECUTABLE_NAME} merge --abort${SGR.reset}
   `,
} as const satisfies CommandHelpObj;

export const structure = {
   $root: ['--target', '--continue', '--abort', '--ff-only', '--no-ff', '--squash'],
} as const satisfies CommandStructure;
