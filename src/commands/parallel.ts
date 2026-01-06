import * as fs from '@/modules/fs';
import path from 'path';

import {
   ncc,
   yuString,
   hyperLink,
   strClamp,
   padEnd,
   strJustify,
   strWrap
} from '@lib/Tools';

import { GdxContext } from '../common/types';
import {
   $,
   $inherit,
   $prompt,
   copyToClipboard,
   openInEditor,
   scheduleChangeDir,
} from '../modules/shell';
import { normalizePath, quickPrint } from '../utils/utilities';
import { EXECUTABLE_NAME, GDX_RESULT_FILE, TEMP_DIR } from '@/consts';

import { COLOR } from '@/consts';
import { _2PointGradient } from '@/modules/graphics';

interface ParallelMetadata {
   alias: string;
   branch: string;
   safeBranch: string;
   project: string;
   safeProject: string;
   originPath: string;
   baseCommit: string;
   createdAt: string;
   updatedAt?: string;
}

interface ParallelContext {
   repoRoot: string;
   projectName: string;
   branchName: string;
   safeProjectName: string;
   safeBranchName: string;
   parallelRoot: string;
   originPath: string;
   alias: string | null;
   isParallelWorktree: boolean;
}

/**
 * Tests if an alias is valid for use as a worktree name
 */
function testParallelAlias(alias: string): boolean {
   if (!alias || alias.trim() === '') return false;
   if (/[/\\ ]/.test(alias)) return false;
   if (/[<>:"|?*\x00-\x1f]/.test(alias)) return false;
   return true;
}

/**
 * Gets metadata from a parallel worktree
 */
async function getParallelMetadata(worktreePath: string): Promise<ParallelMetadata | null> {
   const metaPath = path.join(worktreePath, '.git-parallel.json');

   try {
      const content = await fs.readFile(metaPath, 'utf-8');
      return JSON.parse(content);
   } catch {
      return null;
   }
}

/**
 * Gets the context for parallel worktree operations
 */
async function getParallelContext(git$: string | string[]): Promise<ParallelContext | null> {
   try {
      const repoRoot = (await $`${git$} rev-parse --show-toplevel`).stdout.trim();
      const projectName = path.basename(repoRoot);

      let branchName: string;
      try {
         branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
      } catch {
         branchName = 'HEAD';
      }

      // LINK: dkk2iia forked worktree path
      const worktreeRoot = path.join(TEMP_DIR, 'worktrees');
      const isParallel = repoRoot.startsWith(worktreeRoot.replace(/\\/g, '/'));

      let safeProject = projectName;
      let safeBranch = branchName;

      let alias: string | null = null;
      let originPath = repoRoot;

      if (isParallel) {
         const meta = await getParallelMetadata(repoRoot);
         if (meta) {
            if (meta.branch) branchName = meta.branch;
            if (meta.originPath) originPath = path.resolve(meta.originPath);
            if (meta.alias) alias = meta.alias;
         } else {
            alias = path.basename(repoRoot);
         }
         safeProject = meta?.safeProject || safeProject;
         safeBranch = meta?.safeBranch || safeBranch;
      }

      safeProject = normalizePath(safeProject);
      safeBranch = normalizePath(safeBranch);
      const parallelRoot = path.join(worktreeRoot, safeProject, safeBranch);

      return {
         repoRoot,
         projectName,
         branchName,
         safeProjectName: safeProject,
         safeBranchName: safeBranch,
         parallelRoot,
         originPath,
         alias,
         isParallelWorktree: isParallel,
      };
   } catch (err) {
      quickPrint(yuString(err, { color: true }));
      return null;
   }
}

/**
 * Shows usage information for the parallel command
 */
function showUsage(): void {
   quickPrint('Usage: git parallel <command> [options]');
   quickPrint('');
   quickPrint('Commands:');
   quickPrint(
      '  fork <alias>                    Create a forked worktree in temp and move pending changes'
   );
   quickPrint('  remove <alias>                  Remove a forked worktree');
   quickPrint('  join [<alias>] [--keep] [--all] Merge forked worktree back into origin');
   quickPrint('  Open <alias|origin>             Open a worktree in the default editor');
   quickPrint('  list                            List forked worktrees for the current branch');
}

/**
 * Removes a parallel worktree
 */
async function removeWorktree(git$: string | string[], alias: string): Promise<number> {
   const ctx = await getParallelContext(git$);
   if (!ctx) return 1;

   const targetPath = path.join(ctx.parallelRoot, alias);

   try {
      await fs.access(targetPath);
   } catch {
      quickPrint(
         `${ncc('Red')}Error: Worktree '${alias}' not found for branch '${ctx.branchName}'.${ncc()}`
      );
      return 1;
   }

   try {
      await $inherit`${git$} worktree remove ${targetPath}`;

      // Clean up directory if it still exists
      try {
         await fs.rm(targetPath, { recursive: true, force: true });
      } catch {
         // Ignore cleanup errors
      }

      // LINK: dw2al2m string literal in spec
      quickPrint(`${ncc('Cyan')}Removed worktree:${ncc()} ${alias}`);
      return 0;
   } catch (err) {
      quickPrint(
         `${ncc('Red')}Failed to remove worktree '${alias}'.${ncc()}\n` +
         yuString(err, { color: true })
      );

      const response = await $prompt(
         'Do you want to force remove the worktree directory? This will delete all files in it. (y/n): '
      );
      if (response.toLowerCase() === 'y' || response.toLowerCase() === 'yes') {
         try {
            await fs.rm(targetPath, { recursive: true, force: true });
            quickPrint(`${ncc('Cyan')}Force removed worktree directory:${ncc()} ${alias}`);
            return 0;
         } catch {
            quickPrint(
               `${ncc('Red')}Error: Failed to force remove worktree directory '${alias}'.${ncc()}`
            );
            return 1;
         }
      } else {
         quickPrint(`${ncc('Yellow')}Aborted removing worktree '${alias}'.${ncc()}`);
         return 1;
      }
   }
}

/**
 * Fork command - creates a new parallel worktree
 */
async function cmdFork(git$: string | string[], args: string[]): Promise<number> {
   const ctx = await getParallelContext(git$);
   if (!ctx) return 1;

   if (ctx.isParallelWorktree) {
      quickPrint(
         `${ncc('Red')}Error: Run \`git parallel fork\` from the original worktree, not from a fork.${ncc()}`
      );
      return 1;
   }

   if (ctx.branchName === 'HEAD') {
      quickPrint(
         `${ncc('Red')}Error: Detached HEAD detected. Switch to a branch before forking.${ncc()}`
      );
      return 1;
   }

   if (args.length < 1) {
      quickPrint(`${ncc('Red')}Error: Missing worktree alias.${ncc()}`);
      showUsage();
      return 1;
   }

   const alias = args[0];
   if (!testParallelAlias(alias)) {
      // LINK: dwmal2m string literal in spec
      quickPrint(
         `${ncc('Red')}Error: Alias '${alias}' contains invalid characters or spaces.${ncc()}`
      );
      return 1;
   }

   const targetPath = path.join(ctx.parallelRoot, alias);
   const moveMode = args.includes('--move') || args.includes('-mv');
   const mirrorMode = args.includes('--mirror') || args.includes('-mr');

   if (fs.existsSync(targetPath)) {
      quickPrint(
         `${ncc('Red')}Error: Worktree alias '${alias}' already exists for this branch.${ncc()}`
      );
      return 1;
   }

   // Set .git-parallel.json as ignored file
   const excludePath = path.join(ctx.repoRoot, '.git', 'info', 'exclude');
   try {
      const excludeContent = await fs.readFile(excludePath, 'utf-8');
      if (!excludeContent.includes('.git-parallel.json')) {
         await fs.appendFile(excludePath, '\n.git-parallel.json\n');
      }
   } catch {
      await fs.writeFile(excludePath, '.git-parallel.json\n');
   }

   // Create parallel root directory
   await fs.mkdir(ctx.parallelRoot, { recursive: true });

   // Get base commit
   const baseCommit = (await $`${git$} rev-parse HEAD`).stdout.trim();

   // Check for changes
   const statusOutput = (
      await $`${git$} status --porcelain=v1 --untracked-files=normal`
   ).stdout.trim();
   const hasChanges = statusOutput.length > 0;
   let stashRef: string | null = null;
   let changesOpt: null | string = null;

   if (hasChanges && (moveMode || mirrorMode)) {
      const stashMessage = `git-parallel:${alias}`;
      try {
         if (mirrorMode) {
            const hash = await $`${git$} stash create --include-untracked`;
            await $`${git$} stash store -m ${stashMessage} ${hash}`;
            changesOpt = 'mirrored';
         } else if (moveMode) {
            await $`${git$} stash push --include-untracked -m ${stashMessage}`;
            changesOpt = 'moved';
         }
         stashRef = 'stash@{0}';
      } catch {
         quickPrint(`${ncc('Red')}Error: Failed to stash changes before forking.${ncc()}`);
         return 1;
      }
   }

   // Create worktree
   try {
      await $inherit`${git$} worktree add --detach ${targetPath} HEAD`;
   } catch {
      quickPrint(`${ncc('Red')}Error: Failed to create the parallel worktree.${ncc()}`);
      if (stashRef) {
         await $`${git$} stash pop ${stashRef}`;
         quickPrint(`${ncc('Yellow')}Stashed changes restored to the origin worktree.${ncc()}`);
      }
      return 1;
   }

   // Apply stashed changes to the new worktree
   if (stashRef) {
      try {
         await $`${git$} -C ${targetPath} stash apply --index ${stashRef}`;
         await $`${git$} stash drop ${stashRef}`;
      } catch {
         quickPrint(
            `${ncc('Red')}Error: Failed to move local changes into the new worktree.${ncc()}`
         );
         quickPrint(
            `${ncc('Yellow')}Your changes remain stashed as '${stashRef}'. Apply them manually when ready.${ncc()}`
         );
         quickPrint(`${ncc('Yellow')}Worktree path:${ncc()} ${targetPath}`);
         return 1;
      }
   }

   // Write metadata
   const metadata: ParallelMetadata = {
      alias,
      branch: ctx.branchName,
      safeBranch: ctx.safeBranchName,
      project: ctx.projectName,
      safeProject: ctx.safeProjectName,
      originPath: ctx.repoRoot,
      baseCommit,
      createdAt: new Date().toISOString(),
   };

   const metaPath = path.join(targetPath, '.git-parallel.json');
   await fs.writeFile(metaPath, JSON.stringify(metadata, null, 2), 'utf-8');

   quickPrint(`${ncc('Cyan')}Parallel worktree created:${ncc()} ${targetPath}`);
   if (changesOpt) {
      quickPrint(`${ncc('Cyan')}Pending changes ${changesOpt} to fork '${alias}'.${ncc()}`);
   }

   return 0;
}

/**
 * Remove command - removes a parallel worktree
 */
async function cmdRemove(git$: string | string[], args: string[]): Promise<number> {
   if (args.length < 1) {
      quickPrint(`${ncc('Red')}Error: Missing worktree alias to remove.${ncc()}`);
      showUsage();
      return 1;
   }

   const alias = args[0];
   if (!testParallelAlias(alias)) {
      quickPrint(
         `${ncc('Red')}Error: Alias '${alias}' contains invalid characters or spaces.${ncc()}`
      );
      return 1;
   }

   const ctx = await getParallelContext(git$);
   if (!ctx) return 1;

   const targetPath = path.join(ctx.parallelRoot, alias);

   try {
      await fs.access(targetPath, fs.constants.F_OK | fs.constants.W_OK);
   } catch {
      quickPrint(
         `${ncc('Red')}Error: Worktree '${alias}' not found for branch '${ctx.branchName}' or is not accessible.${ncc()}`
      );
      return 1;
   }

   if (path.resolve(ctx.repoRoot) === path.resolve(targetPath)) {
      quickPrint(
         `${ncc('Red')}Error: Cannot remove the worktree you are currently in. Switch to origin first.${ncc()}`
      );
      return 1;
   }

   // Check for uncommitted changes
   const statusOutput = (
      await $`${git$} -C ${targetPath} status --porcelain=v1 --untracked-files=normal`
   ).stdout.trim();
   if (statusOutput.length > 0) {
      quickPrint(
         `${ncc('Red')}Error: Worktree '${alias}' has uncommitted changes. Join or clean it before removing.${ncc()}`
      );
      return 1;
   }

   return await removeWorktree(git$, alias);
}

/**
 * Open command - opens a different worktree in the editor
 */
async function cmdOpen(
   git$: string | string[],
   args: string[],
   changeDir = false
): Promise<number> {
   const ctx = await getParallelContext(git$);
   if (!ctx) return 1;

   if (args.length < 1) {
      quickPrint(`${ncc('Red')}Error: Missing target worktree alias or 'origin'.${ncc()}`);
      showUsage();
      return 1;
   }

   const target = args[0];

   if (target.toLowerCase() === 'origin') {
      try {
         await fs.access(ctx.originPath);
      } catch {
         quickPrint(
            `${ncc('Red')}Error: Origin worktree path not found at '${ctx.originPath}'.${ncc()}`
         );
         return 1;
      }

      await openInEditor(ctx.originPath);
      return 0;
   }

   if (!testParallelAlias(target)) {
      quickPrint(
         `${ncc('Red')}Error: Alias '${target}' contains invalid characters or spaces.${ncc()}`
      );
      return 1;
   }

   const destination = path.join(ctx.parallelRoot, target);

   if (!(fs.existsSync(destination))) {
      quickPrint(
         `${ncc('Red')}Error: Worktree '${target}' not found for branch '${ctx.branchName}'.${ncc()}`
      );
      return 1;
   }

   if (args.includes('-c') || args.includes('--copy')) {
      await copyToClipboard(destination);
      quickPrint(`${ncc('Cyan')}Worktree path copied to clipboard!${ncc()}`);
      return 0;
   }

   if (changeDir) await scheduleChangeDir(destination);
   else await openInEditor(destination);
   return 0;
}

/**
 * Compares two worktrees and returns commits ahead/behind
 */
async function getCommitComparison(
   git$: string | string[],
   worktreePath: string,
   originPath: string
): Promise<{ ahead: number; behind: number }> {
   try {
      // Get HEAD of both worktrees
      const wtHead = (await $`${git$} -C ${worktreePath} rev-parse HEAD`).stdout.trim();
      const originHead = (await $`${git$} -C ${originPath} rev-parse HEAD`).stdout.trim();

      if (wtHead === originHead) {
         return { ahead: 0, behind: 0 };
      }

      // Count commits ahead (in worktree but not in origin)
      let ahead = 0;
      try {
         const aheadOutput = (
            await $`${git$} -C ${worktreePath} rev-list --count ${originHead}..${wtHead}`
         ).stdout.trim();
         ahead = parseInt(aheadOutput, 10) || 0;
      } catch {
         // If the range is invalid, might be diverged completely
         ahead = 0;
      }

      // Count commits behind (in origin but not in worktree)
      let behind = 0;
      try {
         const behindOutput = (
            await $`${git$} -C ${worktreePath} rev-list --count ${wtHead}..${originHead}`
         ).stdout.trim();
         behind = parseInt(behindOutput, 10) || 0;
      } catch {
         // If the range is invalid, might be diverged completely
         behind = 0;
      }

      return { ahead, behind };
   } catch {
      return { ahead: 0, behind: 0 };
   }
}

/**
 * List command - lists all parallel worktrees
 */
async function cmdList(git$: string | string[], args: string[]): Promise<number> {
   const ctx = await getParallelContext(git$);
   if (!ctx) return 1;

   quickPrint(`${ncc('Cyan')}Project:${ncc()} ${ctx.projectName}`);
   quickPrint(`${ncc('Cyan')}Branch:${ncc()} ${ctx.branchName}`);
   quickPrint(`${ncc('Cyan')}Origin:${ncc()} ${ctx.originPath}`);
   const currentLabel = ctx.isParallelWorktree ? ctx.alias : 'origin';
   quickPrint(`${ncc('Cyan')}Current:${ncc()} ${currentLabel}`);
   quickPrint('');

   if (!(fs.existsSync(ctx.parallelRoot))) {
      // LINK: dkn2ika string literal in spec
      quickPrint(`${ncc('Yellow')}No forked worktrees found for this branch.${ncc()}`);
      return 0;
   }

   const entries = await fs.readdir(ctx.parallelRoot, { withFileTypes: true });
   const worktrees = entries
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));

   if (worktrees.length === 0) {
      quickPrint(`${ncc('Yellow')}No forked worktrees found for this branch.${ncc()}`);
      return 0;
   }

   let hasAnyWt = false;
   for (const wt of worktrees) {
      let wtPath = path.join(ctx.parallelRoot, wt.name);
      const meta = await getParallelMetadata(wtPath);
      if (!meta) continue; // Skip invalid worktrees

      const aliasLabel = meta?.alias || wt.name;
      hasAnyWt = true;

      const statusOutput = (
         await $`${git$} -C ${wtPath} status --porcelain=v1 --untracked-files=normal`
      ).stdout.trim();
      const isDirty = statusOutput.length > 0;

      let shortHead = 'unknown';
      try {
         shortHead = (await $`${git$} -C ${wtPath} rev-parse --short HEAD`).stdout.trim();
      } catch {
         // Keep 'unknown'
      }

      // Get commit comparison with origin
      const { ahead, behind } = await getCommitComparison(git$, wtPath, ctx.originPath);

      let commitInfo = '';
      if (ahead > 0 && behind > 0) {
         commitInfo = `${ncc('Yellow')}↑${ahead} ↓${behind}${ncc()}`;
      } else if (ahead > 0) {
         commitInfo = `${ncc('Green')}↑${ahead}${ncc()}`;
      } else if (behind > 0) {
         commitInfo = `${ncc('Red')}↓${behind}${ncc()}`;
      } else {
         commitInfo = `${ncc('Dim')}up-to-date${ncc()}`;
      }

      const marker = ctx.isParallelWorktree && aliasLabel === ctx.alias ? '●' : '○';
      const statusLabel = isDirty ? `${ncc('Red')}dirty${ncc()}` : `${ncc('Green')}clean${ncc()}`;

      if (args.includes('--short') || args.includes('-s')) {
         // Format path with hyperlink and clamp it to reasonable length
         const clampedPath = strClamp(wtPath, 50, 'mid', -1);
         wtPath = hyperLink(clampedPath, `file://${wtPath.replace(/\\/g, '/')}`);
      }

      quickPrint(
         `${ncc('Dim')}${marker}${ncc()} ${strClamp(aliasLabel, 18, 'end')} ${strJustify(statusLabel, 7, { align: 'center' })} ${ncc('Dim')}${shortHead}${ncc()} ${padEnd(commitInfo, 11)} ${wtPath}`
      );
   }

   if (!hasAnyWt) {
      quickPrint(`${ncc('Yellow')}No forked worktrees found for this branch.${ncc()}`);
   }

   quickPrint('');
   return 0;
}

/**
 * Join command - merges a parallel worktree back to origin
 */
async function cmdJoin(git$: string | string[], args: string[]): Promise<number> {
   const ctx = await getParallelContext(git$);
   if (!ctx) return 1;

   // Parse arguments to separate alias from flags
   const validFlags = ['--keep', '--all'];
   const flags: Set<string> = new Set();
   let targetAlias: string | null = null;

   for (const arg of args) {
      const flag = arg.toLowerCase();
      if (validFlags.includes(flag)) {
         flags.add(flag);
      } else if (!targetAlias && !arg.startsWith('-')) {
         targetAlias = arg;
      } else {
         quickPrint(`${ncc('Red')}Error: Unknown option '${arg}'.${ncc()}`);
         showUsage();
         return 1;
      }
   }

   const keep = flags.has('--keep');
   const bringAll = flags.has('--all');

   // Determine which worktree to join
   let forkPath: string;
   let forkAlias: string;

   if (targetAlias) {
      // Join specified alias from current location
      if (ctx.isParallelWorktree && ctx.alias === targetAlias) {
         quickPrint(
            `${ncc('Red')}Error: Cannot join the fork you are currently in. Switch to origin or another fork first.${ncc()}`
         );
         return 1;
      }

      if (!testParallelAlias(targetAlias)) {
         quickPrint(
            `${ncc('Red')}Error: Alias '${targetAlias}' contains invalid characters or spaces.${ncc()}`
         );
         return 1;
      }

      forkPath = path.join(ctx.parallelRoot, targetAlias);
      forkAlias = targetAlias;

      try {
         await fs.access(forkPath);
      } catch {
         quickPrint(
            `${ncc('Red')}Error: Worktree '${targetAlias}' not found for branch '${ctx.branchName}'.${ncc()}`
         );
         return 1;
      }
   } else {
      // No alias specified - must be run from within a fork
      if (!ctx.isParallelWorktree) {
         quickPrint(
            `${ncc('Red')}Error: Either run join from inside a forked worktree, or specify which fork to join.${ncc()}`
         );
         quickPrint(`${ncc('Yellow')}Usage: git parallel join [<alias>] [--keep] [--all]${ncc()}`);
         return 1;
      }

      forkPath = ctx.repoRoot;
      forkAlias = ctx.alias!;
   }

   const meta = await getParallelMetadata(forkPath);
   if (!meta) {
      quickPrint(
         `${ncc('Red')}Error: Missing metadata for worktree '${forkAlias}'. Unable to join automatically.${ncc()}`
      );
      return 1;
   }

   const originPath = path.resolve(meta.originPath);

   try {
      await fs.access(originPath);
   } catch {
      quickPrint(
         `${ncc('Red')}Error: Original worktree path not found. Expected at '${meta.originPath}'.${ncc()}`
      );
      return 1;
   }

   // Check fork status
   const forkStatus = (
      await $`${git$} -C ${forkPath} status --porcelain=v1 --untracked-files=normal`
   ).stdout.trim();
   const forkDirty = forkStatus.length > 0;

   if (forkDirty && !bringAll) {
      quickPrint(
         `${ncc('Red')}Error: Fork '${forkAlias}' has uncommitted changes. Re-run with --all to include them or clean the worktree first.${ncc()}`
      );
      return 1;
   }

   // Check origin status
   const originStatus = (
      await $`${git$} -C ${originPath} status --porcelain=v1 --untracked-files=normal`
   ).stdout.trim();
   if (originStatus.length > 0) {
      quickPrint(
         `${ncc('Red')}Error: Origin worktree has pending changes. Commit or stash them before joining.${ncc()}`
      );
      return 1;
   }

   const baseCommit = meta.baseCommit?.trim();
   if (!baseCommit) {
      quickPrint(
         `${ncc('Red')}Error: Fork metadata is missing base commit information. Unable to perform an automatic join.${ncc()}`
      );
      return 1;
   }

   let stashRef: string | null = null;

   if (forkDirty && bringAll) {
      const stashMessage = `git-parallel-join:${forkAlias}`;
      try {
         await $`${git$} -C ${forkPath} stash push --include-untracked -m ${stashMessage}`;
         stashRef = 'stash@{0}';
      } catch {
         quickPrint(
            `${ncc('Red')}Error: Failed to stash uncommitted changes before joining.${ncc()}`
         );
         return 1;
      }
   }

   // Get commit list from fork
   let commitList: string[];
   try {
      const forkHead = (await $`${git$} -C ${forkPath} rev-parse HEAD`).stdout.trim();
      const output = (
         await $`${git$} -C ${forkPath} rev-list --reverse ${baseCommit}..${forkHead}`
      ).stdout.trim();
      commitList = output
         ? output
            .split('\n')
            .map((c) => c.trim())
            .filter((c) => c)
         : [];
   } catch {
      if (stashRef) {
         await $`${git$} -C ${forkPath} stash pop ${stashRef}`;
      }
      quickPrint(`${ncc('Red')}Error: Unable to enumerate commits to join.${ncc()}`);
      return 1;
   }

   const appliedCommits: string[] = [];

   for (const commit of commitList) {
      if (!commit) continue;

      try {
         await $inherit`${git$} -C ${originPath} cherry-pick ${commit}`;
         appliedCommits.push(commit);
      } catch {
         await $`${git$} -C ${originPath} cherry-pick --abort`;
         if (stashRef) {
            await $`${git$} -C ${forkPath} stash pop ${stashRef}`;
            quickPrint(
               `${ncc('Yellow')}Stashed changes restored to fork '${forkAlias}' due to cherry-pick failure.${ncc()}`
            );
         }
         quickPrint(
            `${ncc('Red')}Error: Cherry-pick failed while applying commit ${commit}.${ncc()}`
         );
         return 1;
      }
   }

   if (stashRef) {
      try {
         // Get the full stash reference from the fork
         const stashList = (await $`${git$} -C ${forkPath} stash list`).stdout.trim();
         const stashLines = stashList.split('\n');
         const targetStash = stashLines[0]?.split(':')[0] || stashRef;

         await $`${git$} -C ${originPath} stash apply --index ${targetStash}`;
         await $`${git$} -C ${forkPath} stash drop ${targetStash}`;
      } catch {
         quickPrint(
            `${ncc('Red')}Error: Failed to apply uncommitted changes to the origin worktree.${ncc()}`
         );
         try {
            await $`${git$} -C ${forkPath} stash pop ${stashRef}`;
            quickPrint(
               `${ncc('Yellow')}Stashed changes restored to fork '${forkAlias}' for safety.${ncc()}`
            );
         } catch {
            quickPrint(
               `${ncc('Yellow')}Please restore stash '${stashRef}' manually from fork '${forkAlias}'. Automatic pop failed.${ncc()}`
            );
         }
         return 1;
      }
   }

   if (appliedCommits.length > 0) {
      quickPrint(
         `${ncc('Cyan')}Cherry-picked ${appliedCommits.length} commit(s) into origin.${ncc()}`
      );
   } else {
      quickPrint(
         `${ncc('Cyan')}No new commits to cherry-pick. Origin was already up to date.${ncc()}`
      );
   }

   if (!keep) {
      const removeResult = await removeWorktree(git$, forkAlias);
      if (removeResult !== 0) {
         quickPrint(
            `${ncc('Yellow')}Warning: Failed to remove fork '${forkAlias}' after joining. Please remove it manually later.${ncc()}`
         );
         return 1;
      }
      quickPrint(`${ncc('Cyan')}Fork '${forkAlias}' merged and removed successfully.${ncc()}`);
   } else {
      // Update metadata with new base commit
      try {
         const newBase = (await $`${git$} -C ${originPath} rev-parse HEAD`).stdout.trim();
         if (newBase) {
            meta.baseCommit = newBase;
            meta.updatedAt = new Date().toISOString();
            const metaPath = path.join(forkPath, '.git-parallel.json');
            await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
         }
      } catch {
         // Ignore metadata update errors
      }
      quickPrint(
         `${ncc('Cyan')}Fork '${forkAlias}' merged into origin. Worktree kept at:${ncc()} ${forkPath}`
      );
   }

   return 0;
}

/**
 * Main entry point for the parallel command
 */
export default async function parallel(ctx: GdxContext): Promise<number> {
   const { git$, args } = ctx;

   if (args.length < 2) {
      showUsage();
      return 1;
   }

   const subCommand = args[1].toLowerCase();
   const remaining = args.slice(2);

   switch (subCommand) {
      case 'fork':
         return await cmdFork(git$, remaining);
      case 'remove':
         return await cmdRemove(git$, remaining);
      case 'switch':
         if (!GDX_RESULT_FILE) {
            quickPrint(
               `${ncc('Red')}Error: 'git parallel switch' requires the shell integration.${ncc()}`
            );
            return 1;
         }
         return await cmdOpen(git$, remaining, true);
      case 'open':
         return await cmdOpen(git$, remaining);
      case 'list':
         return await cmdList(git$, remaining);
      case 'join':
         return await cmdJoin(git$, remaining);
      case 'help':
         showUsage();
         return 0;
      default:
         showUsage();
         return 1;
   }
}

export const help = {
   long: () =>
      strWrap(
         `
${ncc('Bright') + _2PointGradient('PARALLEL', COLOR.Zinc400, COLOR.Zinc100, 0.2)}
Manage parallel (forked) worktrees for iterative development.

${ncc('Bright') + _2PointGradient('OVERVIEW', COLOR.Zinc400, COLOR.Zinc100, 0.2)}
\`${EXECUTABLE_NAME} parallel\` helps you create and manage temporary forked worktrees for the current branch. Forked worktrees live under a temp worktree root and contain a small metadata file (.git-parallel.json) so the tool can later join, list or remove them cleanly.

${ncc('Bright') + _2PointGradient('SUBCOMMANDS AND BEHAVIOR', COLOR.Zinc400, COLOR.Zinc100, 0.2)}
- ${ncc('Cyan')}fork <alias>${ncc()}: Creates a detached worktree in a safe temporary namespace. If pending changes exist and you run with \`--move\` or \`--mirror\`, changes will be moved/applied to the fork.
- ${ncc('Cyan')}join [<alias>] [--keep|--all]${ncc()}: Cherry-picks commits from the fork back into the origin worktree. \`--keep\` retains the fork and updates its base; \`--all\` also includes uncommitted changes.
- ${ncc('Cyan')}list${ncc()}: Lists forks for the current branch with status (clean/dirty), commit divergence and optional path hyperlinks.
- ${ncc('Cyan')}remove <alias>${ncc()}: Removes the forked worktree and cleans up the directory.

${ncc('Bright') + _2PointGradient('SAFETY AND NOTES', COLOR.Zinc400, COLOR.Zinc100, 0.2)}
Joining cherry-picks commits into origin; conflicts during cherry-pick will abort the join and restore stashes when possible. Removing a fork will also delete the worktree directory when forced.
`,
         100,
         {
            firstIndent: '  ',
            mode: 'softboundery',
            indent: '  ',
         }
      ),
   short: 'Manage temporary forked worktrees: create, list, join, open and remove.',
   usage: () =>
      strWrap(
         `
${ncc('Cyan')}${EXECUTABLE_NAME} parallel fork ${ncc('Dim')}<alias> [--move|--mirror]${ncc()}
${ncc('Cyan')}${EXECUTABLE_NAME} parallel list${ncc()}
${ncc('Cyan')}${EXECUTABLE_NAME} parallel open ${ncc('Dim')}<alias|origin> [-c|--copy]${ncc()}
${ncc('Cyan')}${EXECUTABLE_NAME} parallel join ${ncc('Dim')}<alias> [--keep|--all]${ncc()}
${ncc('Cyan')}${EXECUTABLE_NAME} parallel remove ${ncc('Dim')}<alias>${ncc()}

Examples:
   ${ncc('Cyan')}${EXECUTABLE_NAME} parallel fork feature-x --move ${ncc() + ncc('Dim')}# Create fork and optionally move changes${ncc()}
   ${ncc('Cyan')}${EXECUTABLE_NAME} parallel list --short ${ncc() + ncc('Dim')}# Show forks for current branch${ncc()}
   ${ncc('Cyan')}${EXECUTABLE_NAME} parallel join feature-x --all ${ncc() + ncc('Dim')}# Merge fork back into origin${ncc()}`,
         100,
         {
            firstIndent: '  ',
            mode: 'softboundery',
            indent: '  ',
         }
      ),
};
