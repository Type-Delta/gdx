import * as fs from '@/modules/fs';
import path from 'path';
import { ExecaError } from 'execa';

import { ncc, yuString, hyperLink, strClamp, padEnd, strJustify, strWrap } from '@lib/Tools';

import {
   $,
   $inherit,
   $prompt,
   copyToClipboard,
   isTTY,
   openInEditor,
   scheduleChangeDir,
   spinner,
   SpinnerContoller,
} from '@/modules/shell';
import { normalizePath, progressiveMatch, quickPrint } from '@/utils/utilities';
import Logger from '@/utils/logger';
import { createOptionChildren, createOptionChildrenWithFlags } from '@/utils/structure';
import {
   EXECUTABLE_NAME,
   GDX_RESULT_FILE,
   TEMP_DIR,
   GDX_VPALETTE,
   CATPPUCCIN_VPALETTE,
} from '@/consts';
import { _2PointGradient, bgRgb, fgRgb } from '@/modules/graphics';
import global from '@/global';
import { viewDiff } from '@/modules/diff-viewer';
import { PagerActionResult } from '@/modules/pager';
import {
   deinitSubmodules,
   getDirtySubmodules,
   getSubmodules,
   getWorktreeEntry,
   getWorktreeOperations,
   hasCherryPickInProgress,
   invalidateWorktreeListCache,
   getRepoRootCached,
   pruneWorktrees,
   stageResolvedConflicts,
   isEmptyCherryPickError,
   isCherryPickEmpty,
   getUnmergedPaths,
   getSubmoduleBaseSha,
   getCommitRangeLog,
   forceColorArgs,
   getRevParseCached,
} from '@/modules/git';
import { runWorktreeInit } from '@/modules/worktree-init';
import { ArgsSet } from '@/modules/arguments';
import { CommandHelpObj, CommandStructure, GdxContext, CommandArgThunk } from '../common/types';

interface ParallelMetadata {
   alias: string;
   branch: string;
   safeBranch: string;
   project: string;
   safeProject: string;
   originPath: string;
   baseCommit: string;
   forkBranch?: string;
   forkBranchTracked?: boolean;
   createdAt: string;
   updatedAt?: string;
   joinCursor?: string;
   submoduleCursors?: Record<string, string>;
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

interface CommitGroup {
   label: string;
   commits: string[];
   totalCount: number;
   moreCount: number;
}

interface ConflictInfo {
   files: string[];
   counts?: Record<string, number>;
}

interface InteractiveDecisionContext {
   git$: string | string[];
   gitExec: string;
   originRepoPath: string;
   forkRepoPath: string;
   commit: string;
   forkAlias: string;
   isSubmodule: boolean;
   submodulePath?: string;
}

const PARALLEL_CONTEXT_TTL_MS = 1000;
let parallelContextCache: {
   cacheKey: string;
   context: ParallelContext | null;
   expiresAt: number;
} | null = null;

async function listParallelAliases(git$: string | string[]): Promise<string[]> {
   const ctx = await getParallelContext(git$);
   if (!ctx) return [];

   if (!fs.existsSync(ctx.parallelRoot)) {
      return [];
   }

   const entries = fs.readdirSync(ctx.parallelRoot, { withFileTypes: true });
   const aliases: string[] = [];

   for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const wtPath = path.join(ctx.parallelRoot, entry.name);
      const meta = getParallelMetadata(wtPath);
      if (!meta) continue;
      const aliasLabel = meta.alias || entry.name;
      aliases.push(aliasLabel);
   }

   return aliases.sort((a, b) => a.localeCompare(b));
}

const parallelOpenStructure: CommandArgThunk = async ({ git$ }) => {
   const aliases = await listParallelAliases(git$);
   return createOptionChildrenWithFlags(['origin', ...aliases], ['-c', '--copy']);
};

const parallelSwitchStructure: CommandArgThunk = async ({ git$ }) => {
   const aliases = await listParallelAliases(git$);
   return createOptionChildrenWithFlags(['origin', ...aliases], ['-c', '--copy']);
};

const parallelJoinStructure: CommandArgThunk = async ({ git$ }) => {
   const aliases = await listParallelAliases(git$);
   return {
      $allOf: ['--keep', '--all', '-i', '--interactive'],
      '-r': { $allOf: ['--keep'] },
      '--recursive': { $allOf: ['--keep'] },
      ...createOptionChildrenWithFlags(aliases, ['--keep', '--all', '-i', '--interactive']),
   };
};

const parallelRemoveStructure: CommandArgThunk = async ({ git$ }) => {
   const aliases = await listParallelAliases(git$);
   return {
      '-r': {},
      '--recursive': {},
      ...createOptionChildren(aliases),
   };
};

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
function getParallelMetadata(worktreePath: string): ParallelMetadata | null {
   const metaPath = path.join(worktreePath, '.git-parallel.json');

   try {
      const content = fs.readFileSync(metaPath, 'utf-8');
      const obj = JSON.parse(content) as ParallelMetadata;
      Logger.debug(`Loaded parallel metadata from '${metaPath}': ${yuString(obj)}`, 'parallel');
      return obj;
   } catch {
      return null;
   }
}

function writeParallelMetadata(worktreePath: string, meta: ParallelMetadata): void {
   const metaPath = path.join(worktreePath, '.git-parallel.json');
   fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
}

/**
 * Gets the context for parallel worktree operations
 */
async function getParallelContext(git$: string | string[]): Promise<ParallelContext | null> {
   const gitKey = Array.isArray(git$) ? git$.join(' ') : git$;
   const cacheKey = `${gitKey}|${path.resolve(process.cwd())}`;
   if (parallelContextCache && parallelContextCache.cacheKey === cacheKey) {
      if (Date.now() <= parallelContextCache.expiresAt) {
         return parallelContextCache.context;
      }
      parallelContextCache = null;
   }

   try {
      const repoRoot = await getRepoRootCached(git$);
      let projectName = path.basename(repoRoot);

      const gitExec = Array.isArray(git$) ? git$[0] : git$;
      let branchName: string;
      try {
         branchName = (await getRevParseCached(gitExec, repoRoot, ['--abbrev-ref', 'HEAD'])).trim();
      } catch {
         branchName = 'HEAD';
      }

      // LINK: dkk2iia forked worktree path
      const worktreeRoot = path.join(TEMP_DIR, 'worktrees');
      const isParallel = fs.isChildrenOf(worktreeRoot, repoRoot);

      let safeProject = projectName;
      let safeBranch = branchName;

      let alias: string | null = null;
      let originPath = repoRoot;

      if (isParallel) {
         const meta = getParallelMetadata(repoRoot);
         if (meta) {
            if (meta.project) projectName = meta.project;
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

      const context: ParallelContext = {
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

      parallelContextCache = {
         cacheKey,
         context,
         expiresAt: Date.now() + PARALLEL_CONTEXT_TTL_MS,
      };

      return context;
   } catch (err) {
      Logger.error(yuString(err, { color: true }), 'parallel');
      parallelContextCache = {
         cacheKey,
         context: null,
         expiresAt: Date.now() + PARALLEL_CONTEXT_TTL_MS,
      };
      return null;
   }
}

/**
 * Removes a parallel worktree
 */
async function removeWorktree(git$: string | string[], alias: string): Promise<number> {
   const ctx = await getParallelContext(git$);
   if (!ctx) return 1;

   Logger.debug(`Removing worktree '${alias}'...`, 'parallel');
   const targetPath = path.join(ctx.parallelRoot, alias);
   const gitExec = Array.isArray(git$) ? git$[0] : git$;
   const spinnerCtrl = spinner({
      message: `Preparing worktree for removal...`,
   });

   await invalidateWorktreeListCache(git$);
   const worktreeEntry = await getWorktreeEntry(git$, targetPath);
   if (!worktreeEntry && !fs.existsSync(targetPath)) {
      spinnerCtrl.stop();
      Logger.error(`Worktree '${alias}' not found for branch '${ctx.branchName}'.`, 'parallel');
      return 1;
   }

   if (worktreeEntry?.locked) {
      const reason = worktreeEntry.lockReason ? ` (${worktreeEntry.lockReason})` : '';
      spinnerCtrl.stop();
      Logger.error(
         `Worktree '${alias}' is locked ${reason}. Unlock it before removing.`,
         'parallel'
      );
      return 1;
   }

   if (!fs.existsSync(targetPath)) {
      Logger.debug(
         `Worktree path '${targetPath}' is missing on disk. Attempting prune...`,
         'parallel'
      );

      await pruneWorktrees(git$);
      const afterPrune = await getWorktreeEntry(git$, targetPath);
      if (!afterPrune) {
         spinnerCtrl.stop();
         quickPrint(`${ncc('Cyan')}Removed worktree metadata:${ncc()} ${alias}`);
         Logger.debug(`Worktree '${alias}' pruned successfully.`, 'parallel');
         return 0;
      }

      Logger.error(`Worktree '${alias}' is missing on disk and could not be pruned.`, 'parallel');
      return 1;
   }

   try {
      fs.accessSync(targetPath, fs.constants.F_OK | fs.constants.W_OK);
   } catch {
      spinnerCtrl.stop();
      Logger.error(`Worktree '${alias}' is not accessible or writable. Cannot remove.`, 'parallel');
      return 1;
   }
   Logger.debug(`Worktree path '${targetPath}' is accessible.`, 'parallel');

   const activeOps = await getWorktreeOperations(git$, targetPath);
   Logger.debug(
      `Active operations for worktree '${alias}': ${activeOps.length > 0 ? activeOps.join(', ') : 'none'}`,
      'parallel'
   );
   if (activeOps.length > 0) {
      spinnerCtrl.stop();
      Logger.error(
         `Worktree '${alias}' has in-progress operations (${activeOps.join(', ')}). Complete or abort them before removing.`,
         'parallel'
      );
      return 1;
   }

   const statusOutput = (
      await $`${gitExec} -C ${targetPath} status --porcelain=v1 --untracked-files=normal`
   ).stdout.trim();
   if (statusOutput.length > 0) {
      spinnerCtrl.stop();
      Logger.error(
         `Worktree '${alias}' has uncommitted changes. Join or clean it before removing.`,
         'parallel'
      );
      return 1;
   }

   const submodules = await getSubmodules(git$, targetPath);
   Logger.debug(
      `Submodules in worktree '${alias}': ${submodules.length > 0 ? submodules.map((s) => s.path).join(', ') : 'none'}`,
      'parallel'
   );

   // deinit submodules
   if (submodules.length > 0) {
      const dirtySubmodules = await getDirtySubmodules(git$, targetPath, submodules);
      if (dirtySubmodules.length > 0) {
         const detail = dirtySubmodules.join(', ');
         spinnerCtrl.stop();
         Logger.error(
            `Worktree '${alias}' has dirty submodules (${detail}). Commit, stash, or clean them before removing.`,
            'parallel'
         );
         return 1;
      }

      Logger.debug(`Deinitializing submodules for worktree '${alias}'...`, 'parallel');
      spinnerCtrl.options.message = `Deinitializing submodules...`;
      try {
         Logger.debug(
            `Executing deinit for submodules with ${gitExec} -C ${targetPath}...`,
            'parallel'
         );
         await deinitSubmodules(git$, targetPath);
      } catch (err) {
         spinnerCtrl.stop();
         const fallbackStatus = (
            await $`${gitExec} -C ${targetPath} status --porcelain=v1 --untracked-files=normal`
         ).stdout.trim();
         if (fallbackStatus.length === 0) {
            await pruneWorktrees(git$);
         }

         Logger.error(
            `Failed to deinit submodules for '${alias}'.\n${yuString(err, { color: true })}`,
            'parallel'
         );
         return 1;
      }
   }

   spinnerCtrl.options = {
      ...spinnerCtrl.options,
      frames: [
         '███',
         '██▇',
         '██▆',
         '▇▅▆',
         '▆▅▆',
         '▃▅▅',
         '▄▅▄',
         '▃▃▁',
         '▂▂▂',
         '▁ ▁',
         '   ',
         '░  ',
         '▓░ ',
         '█▓░',
         '██▓',
      ],
      interval: 120,
      message: `Removing worktree '${alias}'...`,
   };

   try {
      Logger.debug(`Executing git worktree remove for '${alias}'...`, 'parallel');
      const result = await $`${git$} worktree remove ${targetPath}`;
      spinnerCtrl.stop();

      quickPrint(result.stdout.trim());

      // Clean up directory if it still exists
      try {
         Logger.debug(`Removing directory '${targetPath}' (if exists)...`, 'parallel');
         fs.rmSync(targetPath, { recursive: true, force: true });
      } catch {
         // Ignore cleanup errors
         Logger.warn(`Failed to remove directory '${targetPath}', ignoring.`, 'parallel');
      }

      // LINK: dw2al2m string literal in spec
      quickPrint(`${ncc('Cyan')}Removed worktree:${ncc()} ${alias}`);
      return 0;
   } catch (err) {
      spinnerCtrl.stop();
      Logger.debug(
         `Error removing worktree '${alias}': ${yuString(err, { color: true })}`,
         'parallel'
      );

      const errText = err instanceof ExecaError ? `${err.stderr || ''} ${err.message || ''}` : '';
      if (
         errText
            .toLowerCase()
            .includes('working trees containing submodules cannot be moved or removed')
      ) {
         Logger.error(
            `Worktree '${alias}' contains submodules that must be deinitialized before removal.`,
            'parallel'
         );
         return 1;
      }

      if (err instanceof ExecaError && err.exitCode === 255) {
         Logger.error(
            `Folder '${targetPath}' is currently in use or GDX does not have permission to remove it. Please close any applications using it and force remove. (git already removed the connection to the origin worktree, retry may not work)`,
            'parallel'
         );
      } else {
         Logger.error(
            `Failed to remove worktree '${alias}'.\n${yuString(err, { color: true })}`,
            'parallel'
         );
      }

      const response = await $prompt('Do you want to force remove the worktree directory? (y/n): ');
      if (response.toLowerCase() === 'y' || response.toLowerCase() === 'yes') {
         try {
            fs.rmSync(targetPath, { recursive: true, force: true });
            await pruneWorktrees(git$);
            quickPrint(`${ncc('Cyan')}Force removed worktree directory:${ncc()} ${alias}`);
            return 0;
         } catch {
            Logger.error(`Failed to force remove worktree directory '${alias}'.`, 'parallel');
            return 1;
         }
      } else {
         Logger.warn(`Aborted removing worktree '${alias}'.`, 'parallel');
         return 1;
      }
   } finally {
      spinnerCtrl.stop();
   }
}

/**
 * Fork command - creates a new parallel worktree
 */
async function cmdFork(git$: string | string[], args: ArgsSet): Promise<number> {
   const ctx = await getParallelContext(git$);
   if (!ctx) return 1;

   if (ctx.isParallelWorktree) {
      Logger.error(
         'Run `git parallel fork` from the original worktree, not from a fork.',
         'parallel'
      );
      return 1;
   }

   if (ctx.branchName === 'HEAD') {
      Logger.error('Detached HEAD detected. Switch to a branch before forking.', 'parallel');
      return 1;
   }

   if (args.length < 1) {
      Logger.error('Missing worktree alias.', 'parallel');
      showUsage();
      return 1;
   }

   const alias = args[0];
   if (!testParallelAlias(alias)) {
      // LINK: dwmal2m string literal in spec
      Logger.error(`Alias '${alias}' contains invalid characters or spaces.`, 'parallel');
      return 1;
   }

   const parsedArgs = args.slice(1);
   let noInitAll = false;
   let noInitList: string | null = null;

   const wantsBranchCreate = parsedArgs.hasOption('-b');
   const wantsBranchReset = parsedArgs.hasOption('-B');
   if (wantsBranchCreate && wantsBranchReset) {
      Logger.error("Use either '-b' or '-B' to create a branch, not both.", 'parallel');
      showUsage();
      return 1;
   }

   let forkBranch: string | null = null;
   let forkBranchFlag: '-b' | '-B' | null = null;
   if (wantsBranchCreate) {
      forkBranch = parsedArgs.popValue('-b');
      forkBranchFlag = '-b';
   } else if (wantsBranchReset) {
      forkBranch = parsedArgs.popValue('-B');
      forkBranchFlag = '-B';
   }

   if ((wantsBranchCreate || wantsBranchReset) && !forkBranch) {
      Logger.error("Missing branch name for '-b'/'-B'.", 'parallel');
      showUsage();
      return 1;
   }

   if (parsedArgs.hasOption('--no-init')) {
      noInitList = parsedArgs.popValue('--no-init', 0, true);
      if (noInitList === null) {
         noInitAll = true;
      }
   }

   const targetPath = path.join(ctx.parallelRoot, alias);
   const moveMode = parsedArgs.includes('--move') || parsedArgs.includes('-mv');
   const mirrorMode = parsedArgs.includes('--mirror') || parsedArgs.includes('-mr');

   const remainingArgs = parsedArgs.filter(
      (arg) => !['--move', '--mirror', '-mv', '-mr'].includes(arg)
   );
   const unknownArgs = remainingArgs.filter((arg) => arg.startsWith('-'));
   if (unknownArgs.length > 0) {
      Logger.error(`Unknown option '${unknownArgs[0]}'.`, 'parallel');
      showUsage();
      return 1;
   }

   const refArgs = remainingArgs.filter((arg) => !arg.startsWith('-'));
   if (refArgs.length > 1) {
      Logger.error('Too many refs provided. Specify a single ref after the alias.', 'parallel');
      showUsage();
      return 1;
   }
   const forkRef = refArgs[0] || null;

   if (fs.existsSync(targetPath)) {
      Logger.error(`Worktree alias '${alias}' already exists for this branch.`, 'parallel');
      return 1;
   }

   // Set .git-parallel.json as ignored file
   const excludePath = path.join(ctx.repoRoot, '.git', 'info', 'exclude');
   try {
      const excludeContent = fs.readFileSync(excludePath, 'utf-8');
      if (!excludeContent.includes('.git-parallel.json')) {
         fs.appendFileSync(excludePath, '\n.git-parallel.json\n');
      }
   } catch {
      fs.writeFileSync(excludePath, '.git-parallel.json\n');
   }

   // Create parallel root directory
   fs.mkdirSync(ctx.parallelRoot, { recursive: true });

   // Get base commit
   const gitExec = Array.isArray(git$) ? git$[0] : git$;
   let baseCommit = (await getRevParseCached(gitExec, ctx.repoRoot, 'HEAD')).trim();
   if (forkRef) {
      try {
         baseCommit = (await $`${git$} rev-parse ${forkRef}`).stdout.trim() || baseCommit;
      } catch {
         // ignore and keep origin HEAD
      }
   } else if (forkBranch) {
      try {
         baseCommit = (await $`${git$} rev-parse ${forkBranch}`).stdout.trim() || baseCommit;
      } catch {
         // ignore and keep origin HEAD
      }
   }

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
         Logger.error('Failed to stash changes before forking.', 'parallel');
         return 1;
      }
   }

   // Create worktree
   try {
      const targetRef = forkRef || 'HEAD';
      if (forkBranch && forkBranchFlag) {
         await $inherit`${git$} worktree add ${forkBranchFlag} ${forkBranch} ${targetPath} ${targetRef}`;
      } else {
         await $inherit`${git$} worktree add --detach ${targetPath} ${targetRef}`;
      }
   } catch {
      Logger.error('Failed to create the parallel worktree.', 'parallel');
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
         Logger.error('Failed to move local changes into the new worktree.', 'parallel');
         Logger.warn(
            `Your changes remain stashed as '${stashRef}'. Apply them manually when ready.`,
            'parallel'
         );
         Logger.info(`Worktree path: ${targetPath}`, 'parallel');
         return 1;
      }
   }

   // Write metadata
   let forkBranchTracked = false;
   if (forkBranch) {
      forkBranchTracked = true;
   }

   const metadata: ParallelMetadata = {
      alias,
      branch: ctx.branchName,
      safeBranch: ctx.safeBranchName,
      project: ctx.projectName,
      safeProject: ctx.safeProjectName,
      originPath: ctx.repoRoot,
      baseCommit,
      forkBranch: forkBranch || undefined,
      forkBranchTracked: forkBranchTracked || undefined,
      createdAt: new Date().toISOString(),
   };

   writeParallelMetadata(targetPath, metadata);

   quickPrint(`${ncc('Cyan')}Parallel worktree created:${ncc()} ${targetPath}`);
   if (changesOpt) {
      quickPrint(`${ncc('Cyan')}Pending changes ${changesOpt} to fork '${alias}'.${ncc()}`);
   }

   await runWorktreeInit({
      git$,
      worktreePath: targetPath,
      originPath: ctx.repoRoot,
      noInitAll,
      noInitList,
   });

   return 0;
}

/**
 * Remove command - removes a parallel worktree
 */
async function cmdRemove(git$: string | string[], args: ArgsSet): Promise<number> {
   const ctx = await getParallelContext(git$);
   if (!ctx) return 1;

   const validFlags = ['-r', '--recursive'];
   const flags: Set<string> = new Set();
   let targetAlias: string | null = null;

   for (const arg of args) {
      const flag = arg.toLowerCase();
      if (validFlags.includes(flag)) {
         flags.add(flag);
      } else if (!targetAlias && !arg.startsWith('-')) {
         targetAlias = arg;
      } else {
         Logger.error(`Unknown option '${arg}'.`, 'parallel');
         showUsage();
         return 1;
      }
   }

   const recursive = flags.has('-r') || flags.has('--recursive');

   if (recursive && targetAlias) {
      Logger.error('Recursive remove does not accept an alias. Omit <alias> with -r.', 'parallel');
      showUsage();
      return 1;
   }

   if (recursive && ctx.isParallelWorktree) {
      Logger.error('Run recursive remove from the origin worktree, not from a fork.', 'parallel');
      return 1;
   }

   if (recursive) {
      return await cmdRemoveRecursive(git$, ctx);
   }

   if (!targetAlias) {
      Logger.error('Missing worktree alias to remove.', 'parallel');
      showUsage();
      return 1;
   }

   if (!testParallelAlias(targetAlias)) {
      Logger.error(`Alias '${targetAlias}' contains invalid characters or spaces.`, 'parallel');
      return 1;
   }

   const targetPath = path.join(ctx.parallelRoot, targetAlias);

   if (path.resolve(ctx.repoRoot) === path.resolve(targetPath)) {
      Logger.error(
         'Cannot remove the worktree you are currently in. Switch to origin first.',
         'parallel'
      );
      return 1;
   }

   return await removeWorktree(git$, targetAlias);
}

async function cmdRemoveRecursive(git$: string | string[], ctx: ParallelContext): Promise<number> {
   if (!fs.existsSync(ctx.parallelRoot)) {
      quickPrint(`${ncc('Yellow')}No forked worktrees found for this branch.${ncc()}`);
      return 0;
   }

   const entries = fs.readdirSync(ctx.parallelRoot, { withFileTypes: true });
   const worktrees = entries
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));

   if (worktrees.length === 0) {
      quickPrint(`${ncc('Yellow')}No forked worktrees found for this branch.${ncc()}`);
      return 0;
   }

   for (const wt of worktrees) {
      const forkPath = path.join(ctx.parallelRoot, wt.name);
      const meta = getParallelMetadata(forkPath);
      const forkAlias = meta?.alias || wt.name;

      const result = await removeWorktree(git$, forkAlias);
      if (result !== 0) return result;
   }

   return 0;
}

/**
 * Open command - opens a different worktree in the editor
 */
async function cmdOpen(git$: string | string[], args: ArgsSet, changeDir = false): Promise<number> {
   const ctx = await getParallelContext(git$);
   if (!ctx) return 1;

   if (args.length < 1) {
      Logger.error("Missing target worktree alias or 'origin'.", 'parallel');
      showUsage();
      return 1;
   }

   const target = args[0];
   let destination: string;
   if (target.toLowerCase() === 'origin') {
      if (!fs.existsSync(ctx.originPath)) {
         Logger.error(`Origin worktree path not found at '${ctx.originPath}'.`, 'parallel');
         return 1;
      }

      destination = ctx.originPath;
   } else {
      if (!testParallelAlias(target)) {
         Logger.error(`Alias '${target}' contains invalid characters or spaces.`, 'parallel');
         return 1;
      }

      destination = path.join(ctx.parallelRoot, target);

      if (!fs.existsSync(destination)) {
         Logger.error(`Worktree '${target}' not found for branch '${ctx.branchName}'.`, 'parallel');
         return 1;
      }

      if (args.includes('-c') || args.includes('--copy')) {
         await copyToClipboard(destination);
         quickPrint(`${ncc('Cyan')}Worktree path copied to clipboard!${ncc()}`);
         return 0;
      }
   }

   if (changeDir) await scheduleChangeDir(destination);
   else await openInEditor(destination);
   return 0;
}

/**
 * List command - lists all parallel worktrees
 */
async function cmdList(git$: string | string[], args: ArgsSet): Promise<number> {
   const ctx = await getParallelContext(git$);
   if (!ctx) return 1;

   // need to extract git executable because test will inject its own `-C` option which
   // will cause this function to list status of origin worktree instead of the fork
   const gitExec = Array.isArray(git$) ? git$[0] : git$;
   const isShortOutput = args.includes('--short') || args.includes('-s');

   // LINK: iin2ya string literal in spec
   quickPrint(`${ncc('Cyan')}Project:${ncc()} ${ctx.projectName}`);
   quickPrint(`${ncc('Cyan')}Branch:${ncc()} ${ctx.branchName}`);
   quickPrint(`${ncc('Cyan')}Origin:${ncc()} ${ctx.originPath}`);
   const currentLabel = ctx.isParallelWorktree ? ctx.alias : 'origin';
   quickPrint(
      `${ncc('Cyan')}Current:${ncc()} ${currentLabel} ${currentLabel !== 'origin' ? ncc('Dim') + '(use "origin" alias to refer to main worktree)' + ncc() : ''}\n`
   );

   if (!fs.existsSync(ctx.parallelRoot)) {
      // LINK: dkn2ika string literal in spec
      quickPrint(`${ncc('Yellow')}No forked worktrees found for this branch.${ncc()}`);
      return 0;
   }

   const entries = fs.readdirSync(ctx.parallelRoot, { withFileTypes: true });
   const worktrees = entries
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));

   if (worktrees.length === 0) {
      quickPrint(`${ncc('Yellow')}No forked worktrees found for this branch.${ncc()}`);
      return 0;
   }

   let hasAnyWt = false;
   for (const wt of worktrees) {
      const wtPath = path.join(ctx.parallelRoot, wt.name);
      const meta = getParallelMetadata(wtPath);
      if (!meta) {
         Logger.debug(
            `Skipping worktree at '${wtPath}' due to missing or invalid metadata.`,
            'parallel'
         );
         continue;
      }

      const aliasLabel = meta?.alias || wt.name;
      const baseCommit = meta.baseCommit?.trim();
      const joinCursor = meta.joinCursor?.trim();
      hasAnyWt = true;

      const mainRangeStart =
         baseCommit && (await isUsableJoinCursor(gitExec, wtPath, baseCommit, joinCursor))
            ? joinCursor!
            : baseCommit;

      const spinnerCtrl = spinner({ message: `Gatering information for ${aliasLabel}...` });
      const originHead = await getRevParseCached(gitExec, ctx.originPath, 'HEAD');
      const originHeadRef = originHead.trim() ? [originHead.trim()] : [];
      const maxLogCount = isShortOutput ? 3 : undefined;
      const [statusOutputRaw, comparison, mainLog, submoduleLog] = await Promise.all([
         // get dirty status
         $`${git$} -C ${wtPath} status --porcelain=v1 --untracked-files=normal`.then((r) =>
            r.stdout.trim()
         ),
         // Get commit comparison with origin
         getCommitComparison(git$, wtPath, ctx.originPath, mainRangeStart),
         mainRangeStart
            ? getCommitRangeLog({
                 gitExec,
                 repoPath: wtPath,
                 range: `${mainRangeStart}..HEAD`,
                 maxCount: maxLogCount,
                 formatTemplate: `${ncc('Yellow')}%h${ncc()} %s`,
                 excludeRefs: originHeadRef,
              })
            : Promise.resolve({ commits: [], totalCount: 0, moreCount: 0 }),
         baseCommit
            ? getSubmoduleCommitGroups(
                 {
                    git$,
                    gitExec,
                    worktreePath: wtPath,
                    originPath: ctx.originPath,
                    baseCommit,
                    maxCount: maxLogCount,
                    submoduleCursors: meta.submoduleCursors,
                 },
                 spinnerCtrl
              )
            : Promise.resolve({ groups: [], totalCount: 0 }),
      ]);

      const isDirty = statusOutputRaw.length > 0;
      const baseShort = mainRangeStart ? mainRangeStart.slice(0, 7) : 'unknown';

      const mainCount = comparison.ahead;
      const submoduleCount = submoduleLog.totalCount;
      const hasAhead = mainCount > 0 || submoduleCount > 0;
      const aheadLabel = submoduleCount > 0 ? `${mainCount}+${submoduleCount}` : `${mainCount}`;

      let commitInfo = '';
      if (hasAhead && comparison.behind > 0) {
         commitInfo = `${ncc('Yellow')}↑${aheadLabel} ↓${comparison.behind}${ncc()}`;
      } else if (hasAhead) {
         commitInfo = `${ncc('Green')}↑${aheadLabel}${ncc()}`;
      } else if (comparison.behind > 0) {
         commitInfo = `${ncc('Red')}↓${comparison.behind}${ncc()}`;
      } else {
         commitInfo = `${ncc('Dim')}up-to-date${ncc()}`;
      }

      const marker = ctx.isParallelWorktree && aliasLabel === ctx.alias ? '●' : '○';
      const statusLabel = isDirty ? `${ncc('Red')}dirty${ncc()}` : `${ncc('Green')}clean${ncc()}`;
      const branchInfo = meta.forkBranch ? `${ncc('Dim')}(branch:${meta.forkBranch})${ncc()}` : '';

      let displayPath = wtPath;
      if (isShortOutput) {
         // Format path with hyperlink and clamp it to reasonable length
         const clampedPath = strClamp(wtPath, 50, 'mid', -1);
         displayPath = hyperLink(clampedPath, `file://${wtPath.replace(/\\/g, '/')}`);
      }

      spinnerCtrl.stop();
      quickPrint(
         `${ncc('Dim')}${marker}${ncc()} ${strClamp(aliasLabel, 18, 'end')} ${strJustify(statusLabel, 7, { align: 'center' })} ${ncc('Dim')}${baseShort}${ncc()} ${padEnd(commitInfo, 11)} ${displayPath}${branchInfo ? ` ${branchInfo}` : ''}`
      );

      if (baseCommit) {
         if (submoduleLog.groups.length > 0) {
            const groups: CommitGroup[] = [
               {
                  label: `. ${ncc('Dim')}[main]${ncc()}`,
                  commits: mainLog.commits,
                  totalCount: mainLog.totalCount,
                  moreCount: mainLog.moreCount,
               },
               ...submoduleLog.groups,
            ];
            printCommitGroups(groups);
         } else if (mainLog.totalCount > 0) {
            printCommitBlock('  ', mainLog.commits, mainLog.moreCount);
         }
      }
   }

   if (!hasAnyWt) {
      quickPrint(`${ncc('Yellow')}No forked worktrees found for this branch.${ncc()}`);
   }

   quickPrint('');
   return 0;
}

async function restoreJoinStash(
   git$: string | string[],
   forkPath: string,
   forkAlias: string,
   stashRef: string
): Promise<void> {
   try {
      await $`${git$} -C ${forkPath} stash pop ${stashRef}`;
      quickPrint(
         `${ncc('Yellow')}Stashed changes restored to fork '${forkAlias}' due to cherry-pick failure.${ncc()}`
      );
   } catch (err) {
      quickPrint(
         `${ncc('Yellow')}Please restore stash '${stashRef}' manually from fork '${forkAlias}'. Automatic pop failed.${ncc()}`
      );
      Logger.debug(yuString(err, { color: true }), 'parallel');
   }
}

async function printCherryPickSteps(
   originPath: string,
   forkAlias: string,
   commit: string,
   stashRef: string | null,
   unmergedPaths: string[]
): Promise<void> {
   quickPrint(
      `${ncc('Yellow')}Cherry-pick stopped at commit ${commit}. To resolve conflicts run:${ncc()}`
   );
   quickPrint(`${ncc('Cyan')}${`  git -C "${originPath}" cherry-pick ${commit}`}${ncc()}`);
   if (unmergedPaths.length > 0) {
      const quotedPaths = unmergedPaths.map((filePath) =>
         filePath.includes(' ') ? `"${filePath}"` : filePath
      );
      const joinedPaths = quotedPaths.join(' ');
      quickPrint(`${ncc('Cyan')}${`  git -C "${originPath}" add -- ${joinedPaths}`}${ncc()}`);
   } else {
      quickPrint(`${ncc('Cyan')}${`  git -C "${originPath}" add -A`}${ncc()}`);
   }
   quickPrint(`${ncc('Cyan')}${`  git -C "${originPath}" cherry-pick --continue`}${ncc()}`);
   quickPrint(`${ncc('Cyan')}${`  ${EXECUTABLE_NAME} parallel join ${forkAlias}`}${ncc()}`);

   if (stashRef) {
      quickPrint(
         `${ncc('Dim')}Stashed changes from fork '${forkAlias}' can be applied after join.${ncc()}`
      );
   }
}

function normalizePagerResult(result?: PagerActionResult | void): PagerActionResult {
   if (!result) return { action: 'abort', key: 'q' };
   return result;
}

async function getCommitInfo(
   gitExec: string,
   repoPath: string,
   commit: string
): Promise<{
   hash: string;
   authorName: string;
   authorEmail: string;
   authorDate: string;
   message: string;
}> {
   const format = ['%H', '%an', '%ae', '%ad', '%B'].join('%n');
   const output = (
      await $`${gitExec} -C ${repoPath} show -s --date=iso --format=${format} ${commit}`
   ).stdout;
   const lines = output.split('\n');
   const [hash, authorName, authorEmail, authorDate, ...messageLines] = lines;
   const message = messageLines.join('\n').trimEnd();
   return {
      hash: hash?.trim() || commit,
      authorName: authorName?.trim() || 'unknown',
      authorEmail: authorEmail?.trim() || 'unknown',
      authorDate: authorDate?.trim() || 'unknown',
      message: message.length > 0 ? message : '(no message)',
   };
}

async function getCherryPickPreview(options: {
   gitExec: string;
   originRepoPath: string;
   forkRepoPath: string;
   commit: string;
   spinner?: SpinnerContoller;
}): Promise<{
   diff: string;
   stat: string;
   isEmpty: boolean;
   hasConflicts: boolean;
   warning?: string;
   appliedPatch?: boolean;
   conflictInfo?: ConflictInfo;
}> {
   const { gitExec, originRepoPath, forkRepoPath, commit, spinner } = options;

   if (spinner) spinner.options.message = 'Emulating cherry-pick...';
   const patch = (await $`${gitExec} -C ${forkRepoPath} show --format= --no-color ${commit}`)
      .stdout;

   if (patch.trim().length === 0) {
      return {
         diff: '',
         stat: '',
         isEmpty: true,
         hasConflicts: false,
         appliedPatch: true,
      };
   }

   const tempRoot = path.join(TEMP_DIR, 'parallel-join-preview');
   fs.mkdirSync(tempRoot, { recursive: true });
   const tempDir = fs.mkdtempSync(path.join(tempRoot, 'index-'));
   const tempIndex = path.join(tempDir, 'index');
   const env = { ...process.env, GIT_INDEX_FILE: tempIndex };

   try {
      await $({ env })`${gitExec} -C ${originRepoPath} read-tree HEAD`;
      let appliedPatch = false;
      let applyConflictInfo: ConflictInfo | undefined;
      let checkResult: { applies: boolean; conflictInfo?: ConflictInfo } | undefined;
      let patchConflictInfo: ConflictInfo | undefined;
      try {
         await $({
            env,
            input: patch,
         })`${gitExec} -C ${originRepoPath} apply --cached --3way --whitespace=nowarn`;
         appliedPatch = true;
      } catch (err) {
         applyConflictInfo = parseApplyConflictInfo(err);
      }

      if (!appliedPatch) {
         checkResult = await checkApplyPatch({ gitExec, originRepoPath, patch, env });
         if (checkResult.applies) {
            try {
               await $({
                  env,
                  input: patch,
               })`${gitExec} -C ${originRepoPath} apply --cached --whitespace=nowarn`;
               appliedPatch = true;
               applyConflictInfo = undefined;
            } catch (err) {
               applyConflictInfo = mergeConflictInfo(
                  applyConflictInfo,
                  parseApplyConflictInfo(err)
               );
            }
         } else {
            try {
               await $({ env })`${gitExec} -C ${originRepoPath} read-tree HEAD`;
               await $({
                  env,
                  input: patch,
               })`${gitExec} -C ${originRepoPath} apply --cached --whitespace=nowarn`;
               appliedPatch = true;
               applyConflictInfo = undefined;
               checkResult = { applies: true };
            } catch (err) {
               applyConflictInfo = mergeConflictInfo(
                  applyConflictInfo,
                  mergeConflictInfo(checkResult.conflictInfo, parseApplyConflictInfo(err))
               );
            }
         }
      }

      const indexConflictInfo = await getIndexConflictInfo(gitExec, originRepoPath, env);
      let conflictInfo = mergeConflictInfo(indexConflictInfo, applyConflictInfo);
      if (!conflictInfo && !appliedPatch && checkResult && !checkResult.applies) {
         const conflictEnv = {
            ...process.env,
            GIT_INDEX_FILE: path.join(tempDir, 'index-conflict'),
         };
         patchConflictInfo = await getPatchConflictInfoByApply({
            gitExec,
            originRepoPath,
            patch,
            env: conflictEnv,
         });
         if (patchConflictInfo && patchConflictInfo.files.length > 0) {
            const totalFiles = splitPatchByFile(patch).length;
            conflictInfo =
               patchConflictInfo.files.length < totalFiles ? patchConflictInfo : undefined;
         }
      }

      let mergeTreeConflicts = false;
      if (!conflictInfo?.files?.length && !appliedPatch) {
         mergeTreeConflicts = await hasMergeTreeConflicts({
            gitExec,
            originRepoPath,
            forkRepoPath,
            commit,
         });
         if (mergeTreeConflicts && !conflictInfo) {
            if (patchConflictInfo?.files?.length) {
               conflictInfo = patchConflictInfo;
            } else {
               const fallbackInfo = parsePatchConflictInfo(patch);
               if (fallbackInfo?.files?.length) {
                  conflictInfo = fallbackInfo;
               }
            }
         }
      } else if (conflictInfo?.files?.length) {
         mergeTreeConflicts = true;
      }

      let overlapConflicts = false;
      if (!conflictInfo?.files?.length && !appliedPatch && !mergeTreeConflicts) {
         overlapConflicts = await hasOverlapConflicts({
            gitExec,
            originRepoPath,
            forkRepoPath,
            commit,
         });
      }

      const hasConflicts =
         Boolean(conflictInfo?.files?.length) || mergeTreeConflicts || overlapConflicts;

      if (!appliedPatch) {
         const diff = (await $`${gitExec} -C ${forkRepoPath} show --format= --no-color ${commit}`)
            .stdout;
         const stat = (
            await $`${gitExec} -C ${forkRepoPath} show --stat --format= --no-color ${commit}`
         ).stdout;
         const warning = hasConflicts
            ? 'Patch does not apply cleanly to origin HEAD. Preview shows the original commit diff.'
            : undefined;
         return {
            diff,
            stat,
            isEmpty: diff.trim().length === 0,
            hasConflicts,
            warning,
            appliedPatch: false,
            conflictInfo,
         };
      }

      const diff = (await $({ env })`${gitExec} -C ${originRepoPath} diff --cached --no-color`)
         .stdout;
      const stat = (
         await $({ env })`${gitExec} -C ${originRepoPath} diff --cached --stat --no-color`
      ).stdout;
      return {
         diff,
         stat,
         isEmpty: diff.trim().length === 0,
         hasConflicts,
         appliedPatch,
         conflictInfo,
      };
   } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
   }
}

async function hasMergeTreeConflicts(options: {
   gitExec: string;
   originRepoPath: string;
   forkRepoPath: string;
   commit: string;
}): Promise<boolean> {
   const { gitExec, originRepoPath, forkRepoPath, commit } = options;
   try {
      const parent = (await $`${gitExec} -C ${forkRepoPath} rev-parse ${commit}^`).stdout.trim();
      if (!parent) return false;
      const originHead = (await $`${gitExec} -C ${originRepoPath} rev-parse HEAD`).stdout.trim();
      if (!originHead) return false;
      const output = (
         await $`${gitExec} -C ${originRepoPath} merge-tree ${parent} ${originHead} ${commit}`
      ).stdout;
      return /^(<{7}|	<{7})/m.test(output);
   } catch {
      return false;
   }
}

async function hasOverlapConflicts(options: {
   gitExec: string;
   originRepoPath: string;
   forkRepoPath: string;
   commit: string;
}): Promise<boolean> {
   const { gitExec, originRepoPath, forkRepoPath, commit } = options;
   try {
      const parent = (await $`${gitExec} -C ${forkRepoPath} rev-parse ${commit}^`).stdout.trim();
      if (!parent) return false;
      const originHead = (await $`${gitExec} -C ${originRepoPath} rev-parse HEAD`).stdout.trim();
      if (!originHead) return false;

      const forkFilesOutput = (
         await $`${gitExec} -C ${forkRepoPath} show --name-only --format= ${commit}`
      ).stdout.trim();
      if (!forkFilesOutput) return false;
      const forkFiles = new Set(
         forkFilesOutput
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
      );

      const originFilesOutput = (
         await $`${gitExec} -C ${originRepoPath} diff --name-only ${parent} ${originHead}`
      ).stdout.trim();
      if (!originFilesOutput) return false;
      const originFiles = originFilesOutput
         .split('\n')
         .map((line) => line.trim())
         .filter((line) => line.length > 0);
      return originFiles.some((file) => forkFiles.has(file));
   } catch {
      return false;
   }
}

async function getIndexConflictInfo(
   gitExec: string,
   repoPath: string,
   env: NodeJS.ProcessEnv
): Promise<ConflictInfo | undefined> {
   let output = '';
   try {
      output = (
         await $({ env })`${gitExec} -C ${repoPath} diff --cached --name-only --diff-filter=U`
      ).stdout.trim();
   } catch {
      return undefined;
   }

   const files = output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
   if (files.length === 0) return undefined;

   let counts: Record<string, number> | undefined;
   try {
      const combinedDiff = (
         await $({ env })`${gitExec} -C ${repoPath} diff --cached --cc --no-color`
      ).stdout;
      counts = parseCombinedConflictCounts(combinedDiff);
   } catch {
      counts = undefined;
   }

   if (counts) {
      const hasCounts = files.every((file) => typeof counts?.[file] === 'number');
      if (!hasCounts) counts = undefined;
   }

   return { files, counts };
}

async function checkApplyPatch(options: {
   gitExec: string;
   originRepoPath: string;
   patch: string;
   env: NodeJS.ProcessEnv;
}): Promise<{ applies: boolean; conflictInfo?: ConflictInfo }> {
   const { gitExec, originRepoPath, patch, env } = options;
   try {
      await $({
         env,
         input: patch,
      })`${gitExec} -C ${originRepoPath} apply --check --whitespace=nowarn`;
      return { applies: true };
   } catch (err) {
      return { applies: false, conflictInfo: parseApplyConflictInfo(err) };
   }
}

async function getPatchConflictInfoByApply(options: {
   gitExec: string;
   originRepoPath: string;
   patch: string;
   env: NodeJS.ProcessEnv;
}): Promise<ConflictInfo | undefined> {
   const { gitExec, originRepoPath, patch, env } = options;
   const sections = splitPatchByFile(patch);
   if (sections.length === 0) return undefined;

   const files: string[] = [];
   const counts: Record<string, number> = {};

   for (const section of sections) {
      try {
         await $({ env })`${gitExec} -C ${originRepoPath} read-tree HEAD`;
         await $({
            env,
            input: section.patch,
         })`${gitExec} -C ${originRepoPath} apply --cached --3way --whitespace=nowarn`;
      } catch (err) {
         if (!files.includes(section.file)) files.push(section.file);
         const parsed = parseApplyConflictInfo(err);
         const count = parsed?.counts?.[section.file];
         if (typeof count === 'number') counts[section.file] = count;
      }
   }

   if (files.length === 0) return undefined;
   const hasCounts = files.every((file) => typeof counts[file] === 'number');
   return { files, counts: hasCounts ? counts : undefined };
}

function splitPatchByFile(patch: string): { file: string; patch: string }[] {
   const sections: { file: string; lines: string[] }[] = [];
   let current: { file: string; lines: string[] } | null = null;
   const lines = patch.split('\n');

   for (const line of lines) {
      if (line.startsWith('diff --git ')) {
         if (current) sections.push(current);
         const match = line.match(/diff --git a\/(.+?) b\/(.+)/);
         const file = match?.[2]?.trim() || 'unknown';
         current = { file, lines: [line] };
         continue;
      }
      if (line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
         if (current) sections.push(current);
         const file = line.replace(/^diff --(?:cc|combined)\s+/, '').trim() || 'unknown';
         current = { file, lines: [line] };
         continue;
      }
      if (current) current.lines.push(line);
   }

   if (current) sections.push(current);
   return sections
      .filter((section) => section.lines.length > 0)
      .map((section) => ({ file: section.file, patch: section.lines.join('\n') }));
}

function parseApplyConflictInfo(error: unknown): ConflictInfo | undefined {
   const parts: unknown[] = [];
   if (typeof error === 'string') {
      parts.push(error);
   } else if (error instanceof ExecaError) {
      parts.push(error.stderr, error.stdout, error.message, error.shortMessage);
   } else if (error && typeof error === 'object') {
      const typedErr = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
      parts.push(typedErr.stderr, typedErr.stdout, typedErr.message);
   }

   const text = parts
      .map((part) => formatGitOutput(part))
      .filter(Boolean)
      .join('\n');
   if (!text) return undefined;

   const files: string[] = [];
   const counts: Record<string, number> = {};
   const lines = text.split('\n');

   for (const line of lines) {
      const patchMatch = line.match(/patch failed:\s+(.+?):\d+/i);
      if (patchMatch) {
         const file = patchMatch[1].trim();
         if (!files.includes(file)) files.push(file);
         counts[file] = (counts[file] || 0) + 1;
         continue;
      }

      const applyMatch = line.match(/error:\s+(.+?):\s+patch does not apply/i);
      if (applyMatch) {
         const file = applyMatch[1].trim();
         if (!files.includes(file)) files.push(file);
      }
   }

   if (files.length === 0) return undefined;

   const hasCounts = files.every((file) => typeof counts[file] === 'number' && counts[file] > 0);
   return { files, counts: hasCounts ? counts : undefined };
}

function mergeConflictInfo(
   primary?: ConflictInfo,
   fallback?: ConflictInfo
): ConflictInfo | undefined {
   if (!primary && !fallback) return undefined;
   if (!primary) return fallback;
   if (!fallback) return primary;

   const files = primary.files.length > 0 ? primary.files : fallback.files;
   if (files.length === 0) return fallback.files.length > 0 ? fallback : undefined;

   const primaryCounts = pickConflictCounts(primary, files);
   const fallbackCounts = pickConflictCounts(fallback, files);
   return { files, counts: primaryCounts ?? fallbackCounts };
}

function parsePatchConflictInfo(patch: string): ConflictInfo | undefined {
   const files: string[] = [];
   const lines = patch.split('\n');

   for (const line of lines) {
      if (line.startsWith('diff --git ')) {
         const match = line.match(/diff --git a\/(.+?) b\/(.+)/);
         if (match) {
            const file = match[2].trim();
            if (file && !files.includes(file)) files.push(file);
         }
         continue;
      }
      if (line.startsWith('diff --cc ')) {
         const file = line.slice('diff --cc '.length).trim();
         if (file && !files.includes(file)) files.push(file);
         continue;
      }
      if (line.startsWith('diff --combined ')) {
         const file = line.slice('diff --combined '.length).trim();
         if (file && !files.includes(file)) files.push(file);
      }
   }

   if (files.length === 0) return undefined;
   return { files };
}

function pickConflictCounts(
   info: ConflictInfo | undefined,
   files: string[]
): Record<string, number> | undefined {
   if (!info?.counts) return undefined;
   const hasCounts = files.every((file) => typeof info.counts?.[file] === 'number');
   return hasCounts ? info.counts : undefined;
}

function parseCombinedConflictCounts(diffText: string): Record<string, number> {
   const counts: Record<string, number> = {};
   let currentFile: string | null = null;
   const lines = diffText.split('\n');

   for (const line of lines) {
      if (line.startsWith('diff --cc ')) {
         currentFile = line.slice('diff --cc '.length).trim();
         continue;
      }
      if (line.startsWith('diff --combined ')) {
         currentFile = line.slice('diff --combined '.length).trim();
         continue;
      }
      if (line.startsWith('@@@') && currentFile) {
         counts[currentFile] = (counts[currentFile] || 0) + 1;
      }
   }

   return counts;
}

function buildCommitPreamble(options: {
   commitInfo: {
      hash: string;
      authorName: string;
      authorEmail: string;
      authorDate: string;
      message: string;
   };
   stat: string;
   warning?: string;
   isEmpty: boolean;
   isSubmodule: boolean;
   submodulePath?: string;
   conflictInfo?: ConflictInfo;
}): string[] {
   const { commitInfo, stat, warning, isEmpty, isSubmodule, submodulePath, conflictInfo } = options;
   const lines: string[] = [];
   lines.push(`Commit: ${commitInfo.hash}`);
   lines.push(`Author: ${commitInfo.authorName} <${commitInfo.authorEmail}>`);
   lines.push(`Date: ${commitInfo.authorDate}`);
   if (isSubmodule && submodulePath) {
      lines.push(`Scope: submodule ${submodulePath}`);
   }
   lines.push('');
   lines.push(...commitInfo.message.split('\n').map((line) => `  ${line}`));

   const trimmedStat = stat
      .trimEnd()
      .replace(/(\W)(\++)/g, `$1${ncc('Green')}$2${fgRgb(CATPPUCCIN_VPALETTE.overlay0)}`)
      .replace(/(-+)/g, `${ncc('Red')}$1${fgRgb(CATPPUCCIN_VPALETTE.overlay0)}`);
   if (trimmedStat.length > 0) {
      lines.push('');
      lines.push(...trimmedStat.split('\n').map((line) => `   ${line}`));
   }

   if (warning) {
      lines.push('');
      lines.push(
         `Warning: ${ncc('Yellow') + ncc('Bright')}${warning}${ncc('Normal') + fgRgb(CATPPUCCIN_VPALETTE.overlay0)}`
      ); // TODO: make a theme service to handle this kind of thing
   }

   const conflictLines = formatConflictSummary(conflictInfo);
   if (conflictLines.length > 0) {
      lines.push('');
      lines.push(...conflictLines);
   }

   if (isEmpty) {
      lines.push('');
      lines.push(
         `  Note: ${ncc('Blue')}No changes against origin. This commit will be skipped unless applied.${ncc('Normal') + fgRgb(CATPPUCCIN_VPALETTE.overlay0)}`
      );
   }

   return lines;
}

function getInteractiveStatusText(options: { isEmpty: boolean; hasConflicts: boolean }): string {
   const { isEmpty, hasConflicts } = options;
   if (isEmpty) {
      return (
         ncc('BgWhite') +
         ncc('Black') +
         ncc('Bright') +
         ' EMPTY ' +
         ncc() +
         fgRgb(CATPPUCCIN_VPALETTE.overlay0) +
         bgRgb(CATPPUCCIN_VPALETTE.base)
      );
   }
   if (hasConflicts) {
      return (
         ncc('BgRed') +
         ncc('White') +
         ncc('Bright') +
         ' CONFLICT ' +
         ncc() +
         fgRgb(CATPPUCCIN_VPALETTE.overlay0) +
         bgRgb(CATPPUCCIN_VPALETTE.base)
      );
   }
   return (
      ncc('Green') +
      ncc('White') +
      ncc('Bright') +
      ' CLEAN ' +
      ncc() +
      fgRgb(CATPPUCCIN_VPALETTE.overlay0) +
      bgRgb(CATPPUCCIN_VPALETTE.base)
   );
}

function formatConflictSummary(conflictInfo?: ConflictInfo): string[] {
   if (!conflictInfo || conflictInfo.files.length === 0) return [];

   const lines: string[] = ['Conflicts:'];
   const { files, counts } = conflictInfo;
   const hasCounts = counts && files.every((file) => typeof counts?.[file] === 'number');

   if (hasCounts && counts) {
      const maxNameLength = Math.max(...files.map((file) => file.length));
      for (const file of files) {
         const count = counts[file] ?? 0;
         const label = count === 1 ? 'conflict' : 'conflicts';
         lines.push(`  ${padEnd(file, maxNameLength)} | ${count} ${label}`);
      }
      return lines;
   }

   for (const file of files) {
      lines.push(`  ${file}`);
   }

   return lines;
}

async function interactiveCherryPickDecision(
   options: InteractiveDecisionContext
): Promise<PagerActionResult> {
   const { gitExec, originRepoPath, forkRepoPath, commit, isSubmodule, submodulePath } = options;

   const spinnerCtrl = spinner({ message: 'Preparing cherry-pick preview...' });
   const commitInfo = await getCommitInfo(gitExec, forkRepoPath, commit);
   const preview = await getCherryPickPreview({
      gitExec,
      originRepoPath,
      forkRepoPath,
      commit,
      spinner: spinnerCtrl,
   });
   spinnerCtrl.stop();

   const preambleLines = buildCommitPreamble({
      commitInfo,
      stat: preview.stat,
      warning: preview.warning,
      isEmpty: preview.isEmpty,
      isSubmodule,
      submodulePath,
      conflictInfo: preview.conflictInfo,
   });
   const actions = preview.isEmpty
      ? [
           { key: 's', label: 'skip', action: 'skip' },
           { key: 'u', label: 'undo', action: 'undo' },
        ]
      : [
           { key: 'a', label: 'apply', action: 'apply' },
           { key: 's', label: 'skip', action: 'skip' },
           { key: 'u', label: 'undo', action: 'undo' },
        ];

   const statusText = getInteractiveStatusText({
      isEmpty: preview.isEmpty,
      hasConflicts: preview.hasConflicts,
   });

   const diffText = preview.diff.trimEnd();
   const content =
      diffText.length > 0 ? [...preambleLines, '', diffText].join('\n') : preambleLines.join('\n');
   const result = await viewDiff(content, { statusText, actions });
   return normalizePagerResult(result);
}

async function undoLastCherryPick(git$: string | string[], repoPath: string): Promise<boolean> {
   const gitExec = Array.isArray(git$) ? git$[0] : git$;
   try {
      await $`${gitExec} -C ${repoPath} rev-parse --verify HEAD~1`;
   } catch {
      Logger.error('No commit available to undo.', 'parallel');
      return false;
   }

   try {
      await $`${gitExec} -C ${repoPath} reset --hard HEAD~1`;
      quickPrint(`${ncc('Cyan')}Undid last cherry-picked commit in ${repoPath}.${ncc()}`);
      return true;
   } catch (err) {
      Logger.error('Failed to undo last cherry-picked commit.', 'parallel');
      Logger.debug(yuString(err, { color: true }), 'parallel');
      return false;
   }
}

async function isUsableJoinCursor(
   gitExec: string,
   repoPath: string,
   baseCommit: string,
   cursor?: string
): Promise<boolean> {
   if (!cursor) return false;
   const head = (await getRevParseCached(gitExec, repoPath, 'HEAD')).trim();
   if (!head) return false;

   try {
      await $`${gitExec} -C ${repoPath} merge-base --is-ancestor ${baseCommit} ${cursor}`;
      await $`${gitExec} -C ${repoPath} merge-base --is-ancestor ${cursor} ${head}`;
      return true;
   } catch {
      return false;
   }
}

function updateSubmoduleCursor(
   meta: ParallelMetadata,
   submodulePath: string,
   rangeStart: string,
   applied: string[],
   explicitCursor?: string
): void {
   meta.submoduleCursors ??= {};
   if (explicitCursor) {
      meta.submoduleCursors[submodulePath] = explicitCursor;
      return;
   }
   meta.submoduleCursors[submodulePath] = applied[applied.length - 1] || rangeStart;
}

async function joinWorktree(
   git$: string | string[],
   forkPath: string,
   forkAlias: string,
   options: { keep: boolean; bringAll: boolean; interactive: boolean }
): Promise<number> {
   Logger.debug(`Joining worktree '${forkAlias}'...`, 'parallel');

   const { keep, bringAll, interactive } = options;
   const interactiveEnabled = interactive && isTTY();
   if (interactive && !interactiveEnabled) {
      Logger.warn('Interactive join requires a TTY. Proceeding without --interactive.', 'parallel');
   }
   const meta = getParallelMetadata(forkPath);
   if (!meta) {
      Logger.error(
         `Missing metadata for worktree '${forkAlias}'. Unable to join automatically.`,
         'parallel'
      );
      return 1;
   }

   const originPath = path.resolve(meta.originPath);
   if (!fs.existsSync(originPath)) {
      Logger.error(
         `Original worktree path not found. Expected at '${meta.originPath}'.`,
         'parallel'
      );
      return 1;
   }

   if (meta.forkBranch && meta.forkBranchTracked) {
      const forkBranchRef = meta.forkBranch.trim();
      if (forkBranchRef) {
         const remotesOutput = (await $`${git$} -C ${forkPath} remote`).stdout.trim();
         const remotes = remotesOutput
            ? remotesOutput
                 .split('\n')
                 .map((line) => line.trim())
                 .filter((line) => line.length > 0)
            : [];
         if (remotes.length > 0) {
            for (const remote of remotes) {
               try {
                  const remoteOutput = (
                     await $`${git$} -C ${forkPath} ls-remote --heads ${remote} ${forkBranchRef}`
                  ).stdout.trim();
                  if (remoteOutput.length > 0) {
                     Logger.error(
                        `Fork branch '${forkBranchRef}' exists on remote '${remote}'. Use standard git commands to merge it.`,
                        'parallel'
                     );
                     return 1;
                  }
               } catch {
                  // ignore remote lookup failures
               }
            }
         }
      }
   }

   const spinnerCtrl = spinner({ message: `Checking worktree status` });
   const gitExec = Array.isArray(git$) ? git$[0] : git$;
   const [forkStatusResult, originStatusResult, forkHeadResult] = await Promise.all([
      $`${git$} -C ${forkPath} status --porcelain=v1 --untracked-files=normal`,
      $`${git$} -C ${originPath} status --porcelain=v1 --untracked-files=normal`,
      getRevParseCached(gitExec, forkPath, 'HEAD'),
   ]);

   // Check fork status
   const forkStatus = forkStatusResult.stdout.trim();
   const forkDirty = forkStatus.length > 0;
   Logger.debug(
      `Fork worktree '${forkAlias}' dirty status: ${forkDirty ? 'dirty' : 'clean'}`,
      'parallel'
   );

   if (forkDirty && !bringAll && !keep) {
      spinnerCtrl.stop();
      Logger.error(
         `Fork '${forkAlias}' has uncommitted changes. Re-run with --all to include them or clean the worktree first.`,
         'parallel'
      );
      return 1;
   }

   // Check origin status
   const originStatus = originStatusResult.stdout.trim();
   if (originStatus.length > 0 && bringAll && forkDirty) {
      spinnerCtrl.stop();
      Logger.error(
         'Origin worktree has pending changes. Commit or stash them before joining.',
         'parallel'
      );
      return 1;
   }

   const baseCommit = meta.baseCommit?.trim();
   const joinCursor = meta.joinCursor?.trim();
   if (!baseCommit) {
      spinnerCtrl.stop();
      Logger.error(
         'Fork metadata is missing base commit information. Unable to perform an automatic join.',
         'parallel'
      );
      return 1;
   }

   const shouldUseCursor = await isUsableJoinCursor(gitExec, forkPath, baseCommit, joinCursor);
   const mainRangeStart = shouldUseCursor ? joinCursor! : baseCommit;
   const originHead = (await getRevParseCached(gitExec, originPath, 'HEAD')).trim();

   let stashRef: string | null = null;
   if (forkDirty && bringAll) {
      const stashMessage = `git-parallel-join:${forkAlias}`;
      Logger.debug(
         `Stashing uncommitted changes from fork '${forkAlias}' before joining...`,
         'parallel'
      );
      spinnerCtrl.options.message = `Stashing uncommitted changes`;
      try {
         await $`${git$} -C ${forkPath} stash push --include-untracked -m ${stashMessage}`;
         stashRef = 'stash@{0}';
      } catch {
         Logger.error('Failed to stash uncommitted changes before joining.', 'parallel');
         return 1;
      }
   }

   // Get commit list from fork
   const forkHead = forkHeadResult.trim();
   let commitList: string[];
   Logger.debug(
      `Enumerating commits from fork '${forkAlias}' since ${shouldUseCursor ? 'join cursor' : 'base commit'} ${mainRangeStart}...`,
      'parallel'
   );
   spinnerCtrl.options.message = `Enumerating commits to join`;
   try {
      const revListArgs = [
         '-C',
         forkPath,
         'rev-list',
         '--reverse',
         `${mainRangeStart}..${forkHead}`,
      ];
      if (originHead) {
         revListArgs.push('--not', originHead);
      }
      const output = (await $`${gitExec} ${revListArgs}`).stdout.trim();
      commitList = output
         ? output
              .split('\n')
              .map((c) => c.trim())
              .filter((c) => c)
         : [];
   } catch (err) {
      if (stashRef) {
         await $`${git$} -C ${forkPath} stash pop ${stashRef}`;
      }
      Logger.error('Unable to enumerate commits to join.', 'parallel');
      Logger.debug(yuString(err, { color: true }), 'parallel');
      return 1;
   }

   const appliedCommits: string[] = [];
   const appliedIndices: number[] = [];
   const appliedSubmoduleCommits: string[] = [];

   spinnerCtrl.stop();
   Logger.debug(`Found ${commitList.length} commit(s) to cherry-pick into origin.`, 'parallel');

   let index = 0;
   while (index < commitList.length) {
      const commit = commitList[index];
      if (!commit) {
         index++;
         continue;
      }
      try {
         let applied = false;
         let skipped = false;
         if (interactiveEnabled) {
            const interactiveResult = await interactiveCherryPickDecision({
               git$,
               gitExec,
               originRepoPath: originPath,
               forkRepoPath: forkPath,
               commit,
               forkAlias,
               isSubmodule: false,
            });
            if (interactiveResult.action === 'abort') {
               if (stashRef) {
                  await restoreJoinStash(git$, forkPath, forkAlias, stashRef);
               }
               return 1;
            }
            if (interactiveResult.action === 'undo') {
               if (appliedIndices.length === 0) {
                  quickPrint(`${ncc('Yellow')}No commit to undo yet.${ncc()}`);
                  continue;
               }
               const lastAppliedIndex = appliedIndices.pop();
               if (lastAppliedIndex === undefined) {
                  continue;
               }
               const undoResult = await undoLastCherryPick(git$, originPath);
               if (!undoResult) {
                  if (stashRef) {
                     await restoreJoinStash(git$, forkPath, forkAlias, stashRef);
                  }
                  return 1;
               }
               if (appliedCommits.length > 0) {
                  appliedCommits.pop();
               }
               const newCursor =
                  lastAppliedIndex > 0 ? commitList[lastAppliedIndex - 1] : mainRangeStart;
               meta.joinCursor = newCursor;
               writeParallelMetadata(forkPath, meta);
               index = Math.max(lastAppliedIndex, 0);
               continue;
            }
            if (interactiveResult.action === 'skip') {
               skipped = true;
            } else if (interactiveResult.action === 'apply') {
               applied = true;
            }
         } else {
            applied = true;
         }

         if (applied) {
            const appliedResult = await applyCherryPick(git$, {
               originRepoPath: originPath,
               commit,
               contextLabel: 'origin worktree',
               forkAlias,
               stashRef,
            });
            if (appliedResult) {
               appliedCommits.push(commit);
               appliedIndices.push(index);
               meta.joinCursor = commit;
               writeParallelMetadata(forkPath, meta);
            }
         } else if (skipped) {
            meta.joinCursor = commit;
            writeParallelMetadata(forkPath, meta);
         }
      } catch {
         if (stashRef) {
            await restoreJoinStash(git$, forkPath, forkAlias, stashRef);
         }
         return 1;
      }
      index++;
   }

   const submodules = await getSubmodules(git$, forkPath);
   for (let i = 0; i < submodules.length; i++) {
      const submodule = submodules[i];
      spinnerCtrl.start();
      spinnerCtrl.options.message = `Enumerating submodule commits ${i + 1} of ${submodules.length}`;
      const forkSubPath = path.resolve(forkPath, submodule.path);
      const originSubPath = path.resolve(originPath, submodule.path);
      const forkGitMarker = path.join(forkSubPath, '.git');
      const originGitMarker = path.join(originSubPath, '.git');
      if (!fs.existsSync(forkSubPath) || !fs.existsSync(originSubPath)) continue;
      if (!fs.existsSync(forkGitMarker) || !fs.existsSync(originGitMarker)) continue;

      const baseSha = await getSubmoduleBaseSha(gitExec, forkPath, baseCommit, submodule.path);
      if (!baseSha) continue;

      const subCursor = meta.submoduleCursors?.[submodule.path]?.trim();
      const useSubCursor = await isUsableJoinCursor(gitExec, forkSubPath, baseSha, subCursor);
      const subRangeStart = useSubCursor ? subCursor! : baseSha;

      let subCommitList: string[] = [];
      try {
         const subHead = (await getRevParseCached(gitExec, forkSubPath, 'HEAD')).trim();
         const originSubHead = (await getRevParseCached(gitExec, originSubPath, 'HEAD')).trim();
         const subRevListArgs = [
            '-C',
            forkSubPath,
            'rev-list',
            '--reverse',
            `${subRangeStart}..${subHead}`,
         ];
         if (originSubHead) {
            subRevListArgs.push('--not', originSubHead);
         }
         const output = (await $`${gitExec} ${subRevListArgs}`).stdout.trim();
         subCommitList = output
            ? output
                 .split('\n')
                 .map((c) => c.trim())
                 .filter((c) => c)
            : [];
      } catch (err) {
         spinnerCtrl.stop();
         Logger.error(`Unable to enumerate submodule commits for '${submodule.path}'.`, 'parallel');
         Logger.debug(yuString(err, { color: true }), 'parallel');
         if (stashRef) {
            await restoreJoinStash(git$, forkPath, forkAlias, stashRef);
         }
         return 1;
      }

      spinnerCtrl.stop();
      if (subCommitList.length === 0) continue;

      Logger.debug(
         `Found ${subCommitList.length} commit(s) to cherry-pick for submodule '${submodule.path}'.`,
         'parallel'
      );
      const subAppliedIndices: number[] = [];
      let subIndex = 0;
      while (subIndex < subCommitList.length) {
         const commit = subCommitList[subIndex];
         if (!commit) {
            subIndex++;
            continue;
         }
         try {
            try {
               await $`${gitExec} -c protocol.file.allow=always -C ${originSubPath} fetch ${forkSubPath} ${commit}`;
            } catch (fetchErr) {
               Logger.error(
                  `Failed to fetch submodule commit ${commit} from '${submodule.path}'.`,
                  'parallel'
               );
               Logger.debug(yuString(fetchErr, { color: true }), 'parallel');
               if (stashRef) {
                  await restoreJoinStash(git$, forkPath, forkAlias, stashRef);
               }
               return 1;
            }

            let applied = false;
            let skipped = false;
            if (interactiveEnabled) {
               const interactiveResult = await interactiveCherryPickDecision({
                  git$,
                  gitExec,
                  originRepoPath: originSubPath,
                  forkRepoPath: forkSubPath,
                  commit,
                  forkAlias,
                  isSubmodule: true,
                  submodulePath: submodule.path,
               });
               if (interactiveResult.action === 'abort') {
                  if (stashRef) {
                     await restoreJoinStash(git$, forkPath, forkAlias, stashRef);
                  }
                  return 1;
               }
               if (interactiveResult.action === 'undo') {
                  if (subAppliedIndices.length === 0) {
                     quickPrint(`${ncc('Yellow')}No commit to undo yet.${ncc()}`);
                     continue;
                  }
                  const lastAppliedIndex = subAppliedIndices.pop();
                  if (lastAppliedIndex === undefined) {
                     continue;
                  }
                  const undoResult = await undoLastCherryPick(git$, originSubPath);
                  if (!undoResult) {
                     if (stashRef) {
                        await restoreJoinStash(git$, forkPath, forkAlias, stashRef);
                     }
                     return 1;
                  }
                  if (appliedSubmoduleCommits.length > 0) {
                     appliedSubmoduleCommits.pop();
                  }
                  const newCursor =
                     lastAppliedIndex > 0 ? subCommitList[lastAppliedIndex - 1] : subRangeStart;
                  meta.submoduleCursors ??= {};
                  meta.submoduleCursors[submodule.path] = newCursor;
                  writeParallelMetadata(forkPath, meta);
                  subIndex = Math.max(lastAppliedIndex, 0);
                  continue;
               }
               if (interactiveResult.action === 'skip') {
                  skipped = true;
               } else if (interactiveResult.action === 'apply') {
                  applied = true;
               }
            } else {
               applied = true;
            }

            if (applied) {
               const appliedResult = await applyCherryPick(git$, {
                  originRepoPath: originSubPath,
                  commit,
                  contextLabel: `submodule ${submodule.path}`,
                  forkAlias,
                  stashRef,
               });
               if (appliedResult) {
                  appliedSubmoduleCommits.push(commit);
                  subAppliedIndices.push(subIndex);
               }
               updateSubmoduleCursor(
                  meta,
                  submodule.path,
                  subRangeStart,
                  appliedSubmoduleCommits,
                  commit
               );
               writeParallelMetadata(forkPath, meta);
            } else if (skipped) {
               updateSubmoduleCursor(
                  meta,
                  submodule.path,
                  subRangeStart,
                  appliedSubmoduleCommits,
                  commit
               );
               writeParallelMetadata(forkPath, meta);
            }
         } catch {
            if (stashRef) {
               await restoreJoinStash(git$, forkPath, forkAlias, stashRef);
            }
            return 1;
         }
         subIndex++;
      }
   }

   if (stashRef) {
      Logger.debug(
         `Applying stashed uncommitted changes from fork '${forkAlias}' to origin...`,
         'parallel'
      );
      try {
         // Get the full stash reference from the fork
         const stashList = (await $`${git$} -C ${forkPath} stash list`).stdout.trim();
         const stashLines = stashList.split('\n');
         const targetStash = stashLines[0]?.split(':')[0] || stashRef;

         await $`${git$} -C ${originPath} stash apply --index ${targetStash}`;
         await $`${git$} -C ${forkPath} stash drop ${targetStash}`;
      } catch (err) {
         Logger.error(`Failed to apply uncommitted changes to the origin worktree.`, 'parallel');
         Logger.debug(yuString(err, { color: true }), 'parallel');

         try {
            await $`${git$} -C ${forkPath} stash pop ${stashRef}`;
            quickPrint(
               `${ncc('Yellow')}Stashed changes restored to fork '${forkAlias}' for safety.${ncc()}`
            );
         } catch (err) {
            quickPrint(
               `${ncc('Yellow')}Please restore stash '${stashRef}' manually from fork '${forkAlias}'. Automatic pop failed.${ncc()}`
            );
            Logger.debug(yuString(err, { color: true }), 'parallel');
         }
         return 1;
      }
   }

   if (appliedCommits.length > 0 || appliedSubmoduleCommits.length > 0) {
      quickPrint(
         `${ncc('Cyan')}Cherry-picked ${appliedCommits.length} commit(s) into origin.${ncc()}`
      );
      if (appliedSubmoduleCommits.length > 0) {
         quickPrint(
            `${ncc('Cyan')}Cherry-picked ${appliedSubmoduleCommits.length} submodule commit(s) into origin.${ncc()}`
         );
      }
   } else {
      quickPrint(
         `${ncc('Cyan')}No new commits to cherry-pick. Origin was already up to date.${ncc()}`
      );
   }

   if (!keep) {
      Logger.debug(`Removing fork worktree '${forkAlias}' after join...`, 'parallel');
      const removeResult = await removeWorktree(git$, forkAlias);
      if (removeResult !== 0) {
         Logger.warn(
            `Failed to remove fork '${forkAlias}' after joining. Please remove it manually later.`
         );
         return 1;
      }
      quickPrint(`${ncc('Cyan')}Fork '${forkAlias}' merged and removed successfully.${ncc()}`);
   } else {
      // Update metadata with new base commit
      try {
         const newBase = (await getRevParseCached(gitExec, originPath, 'HEAD')).trim();
         if (newBase) {
            meta.baseCommit = newBase;
            meta.updatedAt = new Date().toISOString();
         }
      } catch {
         // Ignore metadata update errors
      }
      meta.joinCursor = undefined;
      meta.submoduleCursors = undefined;
      writeParallelMetadata(forkPath, meta);
      quickPrint(
         `${ncc('Cyan')}Fork '${forkAlias}' merged into origin. Worktree kept at:${ncc()} ${forkPath}`
      );
   }

   return 0;
}

async function cmdJoinRecursive(
   git$: string | string[],
   ctx: ParallelContext,
   keep: boolean
): Promise<number> {
   if (!fs.existsSync(ctx.parallelRoot)) {
      quickPrint(`${ncc('Yellow')}No forked worktrees found for this branch.${ncc()}`);
      return 0;
   }

   const entries = fs.readdirSync(ctx.parallelRoot, { withFileTypes: true });
   const worktrees = entries
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));

   if (worktrees.length === 0) {
      quickPrint(`${ncc('Yellow')}No forked worktrees found for this branch.${ncc()}`);
      return 0;
   }

   let hasAnyWt = false;
   for (const wt of worktrees) {
      const forkPath = path.join(ctx.parallelRoot, wt.name);
      const meta = getParallelMetadata(forkPath);
      if (!meta) continue;
      const forkAlias = meta.alias || wt.name;
      hasAnyWt = true;

      const result = await joinWorktree(git$, forkPath, forkAlias, {
         keep,
         bringAll: false,
         interactive: false,
      });
      if (result !== 0) return result;
   }

   if (!hasAnyWt) {
      quickPrint(`${ncc('Yellow')}No forked worktrees found for this branch.${ncc()}`);
   }

   return 0;
}

/**
 * Join command - merges a parallel worktree back to origin
 */
async function cmdJoin(git$: string | string[], args: ArgsSet): Promise<number> {
   const ctx = await getParallelContext(git$);
   if (!ctx) return 1;

   // Parse arguments to separate alias from flags
   const validFlags = ['--keep', '--all', '--interactive', '-i', '-r', '--recursive'];
   const flags: Set<string> = new Set();
   let targetAlias: string | null = null;

   for (const arg of args) {
      const flag = arg.toLowerCase();
      if (validFlags.includes(flag)) {
         flags.add(flag);
      } else if (!targetAlias && !arg.startsWith('-')) {
         targetAlias = arg;
      } else {
         Logger.error(`Unknown option '${arg}'.`, 'parallel');
         showUsage();
         return 1;
      }
   }

   const keep = flags.has('--keep');
   const bringAll = flags.has('--all');
   const interactive = flags.has('--interactive') || flags.has('-i');
   const recursive = flags.has('-r') || flags.has('--recursive');

   if (recursive && bringAll) {
      Logger.error('Recursive join does not support --all. Join forks individually.', 'parallel');
      showUsage();
      return 1;
   }

   if (recursive && interactive) {
      Logger.error(
         'Recursive join does not support --interactive. Join forks individually.',
         'parallel'
      );
      showUsage();
      return 1;
   }

   if (recursive && targetAlias) {
      Logger.error('Recursive join does not accept an alias. Omit <alias> with -r.', 'parallel');
      showUsage();
      return 1;
   }

   if (recursive && ctx.isParallelWorktree) {
      Logger.error('Run recursive join from the origin worktree, not from a fork.', 'parallel');
      return 1;
   }

   if (recursive) {
      return await cmdJoinRecursive(git$, ctx, keep);
   }

   // Determine which worktree to join
   let forkPath: string;
   let forkAlias: string;

   if (targetAlias) {
      // Join specified alias from current location
      if (ctx.isParallelWorktree && ctx.alias === targetAlias) {
         Logger.error(
            'Cannot join the fork you are currently in. Switch to origin or another fork first.',
            'parallel'
         );
         return 1;
      }

      if (!testParallelAlias(targetAlias)) {
         Logger.error(`Alias '${targetAlias}' contains invalid characters or spaces.`, 'parallel');
         return 1;
      }

      forkPath = path.join(ctx.parallelRoot, targetAlias);
      forkAlias = targetAlias;

      if (!fs.existsSync(forkPath)) {
         Logger.error(
            `Worktree '${targetAlias}' not found for branch '${ctx.branchName}'.`,
            'parallel'
         );
         return 1;
      }
   } else {
      // No alias specified - must be run from within a fork
      if (!ctx.isParallelWorktree) {
         Logger.error(
            'Either run join from inside a forked worktree, or specify which fork to join.',
            'parallel'
         );
         Logger.info(
            'Usage: git parallel join [<alias>] [--keep|--all|--interactive] | git parallel join -r [--keep]',
            'parallel'
         );
         return 1;
      }

      forkPath = ctx.repoRoot;
      forkAlias = ctx.alias!;
   }

   return await joinWorktree(git$, forkPath, forkAlias, { keep, bringAll, interactive });
}

/**
 * Applies a cherry-pick to the origin worktree, handling conflicts interactively
 * if in a TTY environment.
 * Returns true if the commit was applied, false if it was skipped.
 *
 * @param git$ Git executable or command array
 * @param ctx Context for the cherry-pick operation
 * @returns Promise<boolean> Whether the commit was applied
 */
async function applyCherryPick(
   git$: string | string[],
   ctx: {
      originRepoPath: string;
      commit: string;
      contextLabel: string;
      forkAlias: string;
      stashRef: string | null;
   }
): Promise<boolean> {
   const { originRepoPath, commit, contextLabel, forkAlias, stashRef } = ctx;
   Logger.debug(`Cherry-picking commit ${commit} into ${contextLabel}...`, 'parallel');
   const colorArgs = forceColorArgs();
   try {
      const result = await $`${git$} ${colorArgs} -C ${originRepoPath} cherry-pick ${commit}`;
      printGitResult(result);
      return true;
   } catch (err) {
      const shouldSkip = await skipEmptyCherryPick(git$, originRepoPath, err, contextLabel);
      if (shouldSkip) return false;

      printGitResult(getGitErrorOutput(err));

      const hasInProgress = await hasCherryPickInProgress(git$, originRepoPath);
      if (!hasInProgress) {
         Logger.error(`Cherry-pick failed while applying commit ${commit}.`, 'parallel');
         Logger.debug(yuString(err, { color: true }), 'parallel');
         throw err;
      }

      if (!isTTY()) {
         const unmergedPaths = await getUnmergedPaths(git$, originRepoPath);
         await printCherryPickSteps(originRepoPath, forkAlias, commit, stashRef, unmergedPaths);
         Logger.debug(yuString(err, { color: true }), 'parallel');
         throw err;
      }

      quickPrint(
         `${ncc('Yellow')}Cherry-pick paused due to conflicts while applying commit ${commit}.${ncc()}`
      );
      quickPrint(
         `${ncc('Dim')}Resolve conflicts in ${contextLabel}, then choose to continue or abort.${ncc()}`
      );

      while (true) {
         const response = (
            await $prompt('Type c to continue, a to abort, s to skip (c|a|s): ')
         ).toLowerCase();

         switch (response) {
            case 's':
            case 'skip':
               try {
                  await $`${git$} ${colorArgs} -C ${originRepoPath} cherry-pick --skip`;
                  Logger.debug(`Skipped commit ${commit} for ${contextLabel}.`, 'parallel');
                  return false;
               } catch (skipErr) {
                  const stillInProgress = await hasCherryPickInProgress(git$, originRepoPath);
                  if (!stillInProgress) return false;

                  printGitResult(getGitErrorOutput(skipErr));
                  Logger.error(`Failed to skip commit ${commit} for ${contextLabel}.`, 'parallel');
                  Logger.debug(yuString(skipErr, { color: true }), 'parallel');
                  continue;
               }
            case 'c':
            case 'continue':
            case 'y':
            case 'yes':
               try {
                  await stageResolvedConflicts(git$, originRepoPath);
                  const result =
                     await $`${git$} ${colorArgs} -C ${originRepoPath} cherry-pick --continue`;
                  printGitResult(result);
                  return true;
               } catch (continueErr) {
                  const shouldSkip = await skipEmptyCherryPick(
                     git$,
                     originRepoPath,
                     continueErr,
                     contextLabel
                  );
                  if (shouldSkip) return false;

                  printGitResult(getGitErrorOutput(continueErr));

                  const stillInProgress = await hasCherryPickInProgress(git$, originRepoPath);
                  if (stillInProgress) {
                     quickPrint(
                        `${ncc('Yellow')}Cherry-pick still has conflicts. Resolve them and try again.${ncc()}`
                     );
                     Logger.debug(yuString(continueErr, { color: true }), 'parallel');
                     continue;
                  }

                  Logger.error(
                     'Cherry-pick no longer in progress. You may need to resolve the state manually before retrying.',
                     'parallel'
                  );
                  Logger.debug(yuString(continueErr, { color: true }), 'parallel');
                  throw continueErr;
               }
            case 'a':
            case 'abort':
            case 'n':
            case 'no':
               try {
                  const result =
                     await $`${git$} ${colorArgs} -C ${originRepoPath} cherry-pick --abort`;
                  printGitResult(result);
               } catch (abortErr) {
                  printGitResult(getGitErrorOutput(abortErr));
                  Logger.error('Failed to abort cherry-pick.', 'parallel');
                  Logger.debug(yuString(abortErr, { color: true }), 'parallel');
                  throw abortErr;
               }

               Logger.error(`Cherry-pick aborted while applying commit ${commit}.`, 'parallel');
               throw err;
         }
      }
   }
}

async function skipEmptyCherryPick(
   git$: string | string[],
   originPath: string,
   err: unknown,
   contextLabel: string
): Promise<boolean> {
   const hasInProgress = await hasCherryPickInProgress(git$, originPath);
   const shouldSkip =
      isEmptyCherryPickError(err) || (hasInProgress && (await isCherryPickEmpty(git$, originPath)));
   if (!shouldSkip) return false;

   if (!hasInProgress) {
      Logger.debug(`Empty cherry-pick ignored for ${contextLabel}.`, 'parallel');
      return true;
   }

   try {
      await $`${git$} ${forceColorArgs()} -C ${originPath} cherry-pick --skip`;
      Logger.debug(`Skipped empty cherry-pick for ${contextLabel}.`, 'parallel');
      return true;
   } catch (skipErr) {
      printGitResult(getGitErrorOutput(skipErr));
      Logger.error(`Failed to skip empty cherry-pick for ${contextLabel}.`, 'parallel');
      Logger.debug(yuString(skipErr, { color: true }), 'parallel');
      return false;
   }
}

/**
 * Compares two worktrees and returns commits ahead/behind
 *
 * @param git$ Git executable or command array
 * @param worktreePath Path to the worktree to compare
 * @param originPath Path to the origin worktree
 * @returns Promise<{ ahead: number; behind: number }>
 */
async function getCommitComparison(
   git$: string | string[],
   worktreePath: string,
   originPath: string,
   baseCommit?: string
): Promise<{ ahead: number; behind: number }> {
   const gitExec = Array.isArray(git$) ? git$[0] : git$;
   try {
      // Get HEAD of both worktrees
      const [wtHead, originHead] = await Promise.all([
         getRevParseCached(gitExec, worktreePath, 'HEAD').then((r) => r.trim()),
         getRevParseCached(gitExec, originPath, 'HEAD').then((r) => r.trim()),
      ]);

      if (wtHead === originHead) {
         return { ahead: 0, behind: 0 };
      }

      let ahead = 0;
      let behind = 0;
      await Promise.all([
         (async () => {
            // Count commits ahead (in worktree but not in origin)
            try {
               const rangeStart = baseCommit || originHead;
               const aheadOutput = (
                  await $`${gitExec} -C ${worktreePath} rev-list --count ${rangeStart}..${wtHead}`
               ).stdout.trim();
               ahead = parseInt(aheadOutput, 10) || 0;
            } catch {
               // If the range is invalid, might be diverged completely
               ahead = 0;
            }
         })(),
         (async () => {
            // Count commits behind (in origin but not in worktree)
            try {
               const behindOutput = (
                  await $`${gitExec} -C ${worktreePath} rev-list --count ${wtHead}..${originHead}`
               ).stdout.trim();
               behind = parseInt(behindOutput, 10) || 0;
            } catch {
               // If the range is invalid, might be diverged completely
               behind = 0;
            }
         })(),
      ]);

      return { ahead, behind };
   } catch {
      return { ahead: 0, behind: 0 };
   }
}

/**
 * Gets commit logs for submodules since a base commit
 * @param options Options for retrieving submodule commit groups
 * @param options.git$ Git executable or command array
 * @param options.gitExec Git executable path
 * @param options.worktreePath Path to the worktree
 * @param options.baseCommit Base commit SHA to compare against
 * @param options.maxCount Optional maximum number of commits to retrieve per submodule
 * @returns Promise with commit groups and total count
 */
async function getSubmoduleCommitGroups(
   options: {
      git$: string | string[];
      gitExec: string;
      worktreePath: string;
      originPath: string;
      baseCommit: string;
      maxCount?: number;
      submoduleCursors?: Record<string, string>;
   },
   spinner?: SpinnerContoller
): Promise<{ groups: CommitGroup[]; totalCount: number }> {
   const { git$, gitExec, worktreePath, originPath, baseCommit, maxCount, submoduleCursors } =
      options;
   const submodules = await getSubmodules(git$, worktreePath);
   if (submodules.length === 0) return { groups: [], totalCount: 0 };

   const groups: CommitGroup[] = [];
   let totalCount = 0;

   for (const submodule of submodules) {
      const submoduleRepoPath = path.resolve(worktreePath, submodule.path);
      const originSubPath = path.resolve(originPath, submodule.path);
      const gitMarker = path.join(submoduleRepoPath, '.git');
      const originGitMarker = path.join(originSubPath, '.git');
      if (!fs.existsSync(submoduleRepoPath) || !fs.existsSync(gitMarker)) continue;

      if (spinner) spinner.options.message = `Collecting submodule '${submodule.path}'...`;
      const baseSha = await getSubmoduleBaseSha(gitExec, worktreePath, baseCommit, submodule.path);
      if (!baseSha) continue;

      let rangeStart = baseSha;
      const subCursor = submoduleCursors?.[submodule.path];
      if (subCursor) {
         const isCursorValid = await isUsableJoinCursor(
            gitExec,
            submoduleRepoPath,
            baseSha,
            subCursor
         );
         if (isCursorValid) rangeStart = subCursor;
      }

      const range = `${rangeStart}..HEAD`;
      const originSubHead =
         fs.existsSync(originSubPath) && fs.existsSync(originGitMarker)
            ? (await getRevParseCached(gitExec, originSubPath, 'HEAD')).trim()
            : '';
      const logResult = await getCommitRangeLog({
         gitExec,
         repoPath: submoduleRepoPath,
         range,
         maxCount,
         formatTemplate: `${ncc('Yellow')}%h${ncc()} %s`,
         excludeRefs: originSubHead ? [originSubHead] : undefined,
      });

      if (logResult.totalCount === 0) continue;
      const label = `${submodule.path} ${ncc('Dim')}[submodule]${ncc()}`;
      groups.push({
         label,
         commits: logResult.commits,
         totalCount: logResult.totalCount,
         moreCount: logResult.moreCount,
      });
      totalCount += logResult.totalCount;
   }

   return { groups, totalCount };
}

/**
 * Prints a block of commit lines with a prefix and connector lines
 * @param prefix Prefix string for each line
 * @param lines Array of commit lines to print
 * @param moreCount Number of additional commits not shown
 */
function printCommitBlock(prefix: string, lines: string[], moreCount: number): void {
   const renderedLines = [...lines];
   if (moreCount > 0) {
      renderedLines.push(`${ncc('Dim')}+${moreCount} more${ncc()}`);
   }
   if (renderedLines.length === 0) return;

   for (let i = 0; i < renderedLines.length; i++) {
      const isLast = i === renderedLines.length - 1;
      const connector = isLast ? '└─ ' : '├─ ';
      quickPrint(`${ncc('Dim')}${prefix}${connector}${ncc()}${renderedLines[i]}`);
   }
}

/**
 * Prints commit groups with labels and nested commit blocks
 * @param groups Array of commit groups to print
 */
function printCommitGroups(groups: CommitGroup[]): void {
   if (groups.length === 0) return;

   for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      const isLastGroup = i === groups.length - 1;
      const groupConnector = isLastGroup ? '  └─ ' : '  ├─ ';
      quickPrint(`${ncc('Dim')}${groupConnector}${ncc()}${group.label}`);

      const nestedPrefix = isLastGroup ? '     ' : '  │  ';
      printCommitBlock(nestedPrefix, group.commits, group.moreCount);
   }
}

function formatGitOutput(output: unknown): string {
   if (!output) return '';
   if (typeof output === 'string') return output;
   if (output instanceof Uint8Array) return new TextDecoder().decode(output);
   return String(output);
}

function printGitOutput(output: unknown): void {
   const text = formatGitOutput(output);
   if (!text) return;
   quickPrint(text, text.endsWith('\n') ? '' : '\n');
}

function printGitResult(result: { stdout?: unknown; stderr?: unknown }): void {
   printGitOutput(result.stdout);
   printGitOutput(result.stderr);
}

function getGitErrorOutput(err: unknown): { stdout?: unknown; stderr?: unknown } {
   if (err instanceof ExecaError) {
      return { stdout: err.stdout, stderr: err.stderr };
   }
   const typedErr = err as { stdout?: unknown; stderr?: unknown } | null;
   return { stdout: typedErr?.stdout, stderr: typedErr?.stderr };
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

   const inputCommand = args[1].toLowerCase();
   const { match: subCommand, candidates } = progressiveMatch(inputCommand, [
      'fork',
      'list',
      'open',
      'switch',
      'join',
      'remove',
      'help',
   ]);
   const remaining = args.slice(2);

   switch (subCommand) {
      case 'fork':
         return await cmdFork(git$, remaining);
      case 'remove':
         return await cmdRemove(git$, remaining);
      case 'switch':
         if (!GDX_RESULT_FILE) {
            Logger.error(
               `'git parallel switch' requires the shell integration. See readme for details.`
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
         if (candidates && candidates.length > 0) {
            Logger.warn(
               `Ambiguous command '${inputCommand}'. Did you mean one of: ${candidates.join(', ')}?`
            );
         } else {
            Logger.warn(`Unknown subcommand '${inputCommand}'`);
         }

         showUsage();
         return 1;
   }
}

export const help = {
   long: () => {
      const bright = ncc('Bright');
      const cyan = ncc('Cyan');
      const reset = ncc();
      return strWrap(
         `
${bright + _2PointGradient('PARALLEL', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
Manage parallel (forked) worktrees for iterative development.

${bright + _2PointGradient('OVERVIEW', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
\`${cyan}${EXECUTABLE_NAME} parallel${reset}\` helps you create and manage temporary forked worktrees for the current branch. Forked worktrees live under a temp worktree root and contain a small metadata file (.git-parallel.json) so the tool can later join, list or remove them cleanly.

Additionally, \`${cyan}${EXECUTABLE_NAME} parallel fork${reset}\` can auto-initialize submodules,
copy ignored env files, and install dependencies using detected package managers (currently supports
npm, pnpm, bun, and uv) if configured (see \`${cyan}parallel.init${reset}\` and
\`${cyan}parallel.envPaths${reset}\` config for options), getting the fork ready for work in no time.

${bright + _2PointGradient('SUBCOMMANDS AND BEHAVIOR', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
- ${cyan}fork <alias>${reset}: Creates a detached worktree in a safe temporary namespace. Use \`${cyan}-b${reset}\` or \`${cyan}-B${reset}\` to create a non-detached worktree that tracks a local branch. If pending changes exist and you run with \`${cyan}--move${reset}\` or \`${cyan}--mirror${reset}\`, changes will be moved/applied to the fork. Init behaviors (submodules, env file copy, packages) are controlled by config and \`${cyan}--no-init${reset}\`.
- ${cyan}join [<alias>] [--keep|--all|-i|--interactive]${reset}: Cherry-picks commits from the fork back into the origin worktree. \`${cyan}--keep${reset}\` retains the fork and updates its base; \`${cyan}--all${reset}\` also includes uncommitted changes. \`${cyan}--interactive${reset}\` previews and lets you choose each commit before applying.
- ${cyan}join -r|--recursive [--keep]${reset}: Joins every fork for the current branch back into origin. Recursive join does not allow \`${cyan}--all${reset}\`.
- ${cyan}list${reset}: Lists forks for the current branch with status, base commit, divergence and recent commits. Use ${cyan}--short${reset} for compact output.
- ${cyan}remove <alias>${reset}: Removes the forked worktree and cleans up the directory.
- ${cyan}remove -r|--recursive${reset}: Removes every fork for the current branch.

${bright + _2PointGradient('SAFETY AND NOTES', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
Joining cherry-picks commits into origin; conflicts will prompt for resolve/continue in a TTY or print manual steps in non-interactive shells. Removing a fork will also delete the worktree directory when forced.
`,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            mode: 'softboundary',
            indent: '  ',
         }
      );
   },
   short: 'Manage temporary forked worktrees: create, list, join, open and remove.',
   usage: () => {
      const cyan = ncc('Cyan');
      const dim = ncc('Dim');
      const reset = ncc();
      return strWrap(
         `
${cyan}${EXECUTABLE_NAME} parallel fork ${dim}<alias> [ref] [-b|-B <branch>] [--move|--mirror] [--no-init[=submodule,env,pkg]]${reset}
${cyan}${EXECUTABLE_NAME} parallel list${reset}
${cyan}${EXECUTABLE_NAME} parallel open ${dim}<alias|origin> [-c|--copy]${reset}
${cyan}${EXECUTABLE_NAME} parallel switch ${dim}<alias|origin> [-c|--copy]${reset}
${cyan}${EXECUTABLE_NAME} parallel join ${dim}<alias> [--keep|--all|-i|--interactive]${reset}
${cyan}${EXECUTABLE_NAME} parallel join ${dim}-r|--recursive [--keep]${reset}
${cyan}${EXECUTABLE_NAME} parallel remove ${dim}<alias>${reset}
${cyan}${EXECUTABLE_NAME} parallel remove ${dim}-r|--recursive${reset}

Examples:
   ${cyan}${EXECUTABLE_NAME} parallel fork feature-x --move ${reset + dim}# Create fork and optionally move changes${reset}
   ${cyan}${EXECUTABLE_NAME} parallel fork feature-x deadbeef ${reset + dim}# Create fork from a ref${reset}
   ${cyan}${EXECUTABLE_NAME} parallel fork feature-x -b feature-x ${reset + dim}# Create fork on a local branch${reset}
   ${cyan}${EXECUTABLE_NAME} parallel fork feature-x -B feature-x ${reset + dim}# Recreate the fork branch${reset}
   ${cyan}${EXECUTABLE_NAME} parallel fork feature-x --no-init ${reset + dim}# Skip all init behaviors${reset}
   ${cyan}${EXECUTABLE_NAME} parallel fork feature-x --no-init=pkg ${reset + dim}# Skip package installs only${reset}
   ${cyan}${EXECUTABLE_NAME} parallel fork feature-x --no-init=env ${reset + dim}# Skip env file copy${reset}
   ${cyan}${EXECUTABLE_NAME} parallel list --short ${reset + dim}# Compact output with recent commits${reset}
   ${cyan}${EXECUTABLE_NAME} parallel join feature-x --all ${reset + dim}# Merge fork back into origin${reset}
   ${cyan}${EXECUTABLE_NAME} parallel join feature-x -i ${reset + dim}# Preview and pick commits${reset}
   ${cyan}${EXECUTABLE_NAME} parallel join -r ${reset + dim}# Merge all forks back into origin${reset}
   ${cyan}${EXECUTABLE_NAME} parallel remove -r ${reset + dim}# Remove all forks for this branch${reset}`,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            mode: 'softboundary',
            indent: '  ',
         }
      );
   },
} as const satisfies CommandHelpObj;

export const structure = {
   $root: {
      fork: ['--move', '--mirror', '--no-init', '-b', '-B'],
      list: {},
      open: parallelOpenStructure,
      switch: parallelSwitchStructure,
      join: parallelJoinStructure,
      remove: parallelRemoveStructure,
      help: {},
   },
} as const satisfies CommandStructure;

function showUsage(): void {
   quickPrint(help.short + '\n' + help.usage());
}
