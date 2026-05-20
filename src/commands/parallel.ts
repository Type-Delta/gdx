import * as fs from '@/modules/fs';
import path from 'path';
import { ExecaError } from 'execa';

import { yuString, hyperlink, strClamp, padEnd, strJustify, strWrap } from '@lib/Tools';

import {
   $,
   $inherit,
   $prompt,
   copyToClipboard,
   isTTY,
   openInEditor,
   scheduleChangeDir,
   spinner,
   SpinnerController,
} from '@/modules/shell';
import { asUnixPath } from '@/utils/path';
import { normalizePath, progressiveMatch, quickPrint } from '@/utils/utilities';
import Logger from '@/utils/logger';
import { createOptionChildren, createOptionChildrenWithFlags } from '@/utils/structure';
import {
   EXECUTABLE_NAME,
   GDX_RESULT_FILE,
   TEMP_DIR,
   GDX_VPALETTE,
   CATPPUCCIN_VPALETTE,
   SGR,
} from '@/consts';
import { _2PointGradient, bgRgb, fgRgb } from '@/modules/graphics';
import global from '@/global';
import { viewDiff } from '@/modules/diff-viewer';
import { PagerActionResult } from '@/modules/pager';
import {
   deinitSubmodules,
   getDirtySubmodules,
   getGitConfigValue,
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
   revParseCached,
} from '@/modules/git';
import { runWorktreeInit } from '@/modules/worktree-init';
import { ArgsSet } from '@/modules/arguments';
import { CommandHelpObj, CommandStructure, GdxContext, CommandArgThunk } from '../common/types';
import clear from './clear';
import litedent from '@/utils/litedent';

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

let submoduleLocationCache: {
   cacheKey: string;
   value: { repoRoot: string; superprojectPath: string | null; submodulePath: string | null };
   expiresAt: number;
} | null = null;

async function listParallelAliases(git$: string | string[]): Promise<string[]> {
   const ctx = await getParallelContext(git$);
   if (!ctx) return [];

   return listParallelWorktrees(ctx)
      .map((worktree) => worktree.alias)
      .sort((a, b) => a.localeCompare(b));
}

function listParallelWorktrees(ctx: ParallelContext): Array<{ alias: string; path: string }> {
   if (!fs.existsSync(ctx.parallelRoot)) {
      return [];
   }

   const entries = fs.readdirSync(ctx.parallelRoot, { withFileTypes: true });
   const worktrees: Array<{ alias: string; path: string }> = [];

   for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const wtPath = path.join(ctx.parallelRoot, entry.name);
      const meta = getParallelMetadata(wtPath);
      if (!meta) continue;
      worktrees.push({
         alias: meta.alias || entry.name,
         path: wtPath,
      });
   }

   return worktrees.sort((a, b) => a.alias.localeCompare(b.alias));
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

const parallelSyncStructure: CommandArgThunk = async ({ git$ }) => {
   const aliases = await listParallelAliases(git$);
   return createOptionChildrenWithFlags(aliases, ['--hard', '-h']);
};

const parallelPickStructure: CommandArgThunk = async ({ git$ }) => {
   const aliases = await listParallelAliases(git$);
   return createOptionChildren(['origin', ...aliases]);
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

function resetParallelJoinState(meta: ParallelMetadata, baseCommit: string): void {
   meta.baseCommit = baseCommit;
   meta.updatedAt = new Date().toISOString();
   meta.joinCursor = undefined;
   meta.submoduleCursors = undefined;
}

async function getCurrentSubmodulePath(
   git$: string | string[]
): Promise<{ repoRoot: string; superprojectPath: string | null; submodulePath: string | null }> {
   const gitKey = Array.isArray(git$) ? git$.join(' ') : git$;
   const cacheKey = `${gitKey}|${path.resolve(process.cwd())}`;
   if (submoduleLocationCache && submoduleLocationCache.cacheKey === cacheKey) {
      if (Date.now() <= submoduleLocationCache.expiresAt) {
         return submoduleLocationCache.value;
      }
      submoduleLocationCache = null;
   }

   const repoRoot = await getRepoRootCached(git$);
   const superprojectOutput = (
      await revParseCached(git$, '--show-superproject-working-tree')
   ).trim();
   const superprojectPath = superprojectOutput || null;

   if (!superprojectPath) {
      const value = { repoRoot, superprojectPath: null, submodulePath: null };
      submoduleLocationCache = {
         cacheKey,
         value,
         expiresAt: Date.now() + PARALLEL_CONTEXT_TTL_MS,
      };
      return value;
   }

   const value = {
      repoRoot,
      superprojectPath,
      submodulePath: asUnixPath(path.relative(superprojectPath, repoRoot)),
   };
   submoduleLocationCache = {
      cacheKey,
      value,
      expiresAt: Date.now() + PARALLEL_CONTEXT_TTL_MS,
   };
   return value;
}

async function getParallelScope(git$: string | string[]): Promise<{
   gitExec: string;
   repoRoot: string;
   scopeGit$: string | string[];
   parallelCtx: ParallelContext;
   currentLabel: string;
   submodulePath: string | null;
}> {
   const gitExec = Array.isArray(git$) ? git$[0] : git$;
   const location = await getCurrentSubmodulePath(git$);
   const scopeGit$ = location.superprojectPath ? [gitExec, '-C', location.superprojectPath] : git$;
   const parallelCtx = await getParallelContext(scopeGit$);

   if (!parallelCtx) {
      throw new Error('Not inside a git worktree.');
   }

   return {
      gitExec,
      repoRoot: location.repoRoot,
      scopeGit$,
      parallelCtx,
      currentLabel: parallelCtx.isParallelWorktree ? parallelCtx.alias || 'origin' : 'origin',
      submodulePath: location.submodulePath,
   };
}

function resolveParallelWorktreePath(ctx: ParallelContext, alias: string): string {
   return alias === 'origin' ? ctx.originPath : path.join(ctx.parallelRoot, alias);
}

async function ensureCleanWorktreeOrClear(
   gitExec: string,
   repoPath: string,
   hard: boolean
): Promise<boolean> {
   const statusOutput = (
      await $`${gitExec} -C ${repoPath} status --porcelain=v1 --untracked-files=normal`
   ).stdout.trim();

   if (statusOutput.length === 0) {
      return true;
   }

   if (!hard) {
      return false;
   }

   const clearResult = await clear({
      git$: [gitExec, '-C', repoPath],
      args: new ArgsSet(['clear']),
   });
   return clearResult === 0;
}

async function refreshParallelSubmodules(
   gitExec: string,
   repoPath: string,
   hard: boolean
): Promise<void> {
   const updateArgs = ['-c', 'protocol.file.allow=always', '-C', repoPath, 'submodule', 'update'];
   if (hard) updateArgs.push('--force');
   updateArgs.push('--init', '--recursive');
   await $`${gitExec} ${updateArgs}`;
}

function updateJoinCursorContiguously(
   meta: ParallelMetadata,
   forkPath: string,
   commit: string,
   rangeStart: string,
   blocked: boolean
): boolean {
   if (blocked) return blocked;
   meta.joinCursor = commit || rangeStart;
   writeParallelMetadata(forkPath, meta);
   return false;
}

function blockJoinCursorAtCommit(
   meta: ParallelMetadata,
   forkPath: string,
   commit: string,
   blocked: boolean
): boolean {
   if (!blocked) {
      meta.joinCursor = commit;
      writeParallelMetadata(forkPath, meta);
   }
   return true;
}

function blockSubmoduleCursorAtCommit(
   meta: ParallelMetadata,
   forkPath: string,
   submodulePath: string,
   commit: string,
   blocked: boolean
): boolean {
   if (!blocked) {
      meta.submoduleCursors ??= {};
      meta.submoduleCursors[submodulePath] = commit;
      writeParallelMetadata(forkPath, meta);
   }
   return true;
}

async function getCherryPickIdentityArgs(
   gitExec: string,
   targetRepoPath: string,
   sourceRepoPath: string,
   commit: string
): Promise<string[]> {
   const [targetName, targetEmail] = await Promise.all([
      getGitConfigValue(gitExec, targetRepoPath, 'user.name'),
      getGitConfigValue(gitExec, targetRepoPath, 'user.email'),
   ]);

   if (targetName && targetEmail) {
      return [];
   }

   const commitInfo = await getCommitInfo(gitExec, sourceRepoPath, commit);
   const fallbackName = targetName || commitInfo.authorName;
   const fallbackEmail = targetEmail || commitInfo.authorEmail;

   if (!fallbackName || !fallbackEmail) {
      return [];
   }

   return ['-c', `user.name=${fallbackName}`, '-c', `user.email=${fallbackEmail}`];
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
         quickPrint(`${SGR.cyan}Removed worktree metadata:${SGR.reset} ${alias}`);
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
      quickPrint(`${SGR.cyan}Removed worktree:${SGR.reset} ${alias}`);
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
            quickPrint(`${SGR.cyan}Force removed worktree directory:${SGR.reset} ${alias}`);
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
   let scope: Awaited<ReturnType<typeof getParallelScope>>;
   try {
      scope = await getParallelScope(git$);
   } catch (err) {
      Logger.error(yuString(err, { color: true }), 'parallel');
      return 1;
   }

   const ctx = scope.parallelCtx;
   const scopeGit$ = scope.scopeGit$;

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

   if (fs.existsSync(targetPath) && fs.readdirSync(targetPath).length > 0) {
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
   const gitExec = scope.gitExec;
   let baseCommit = (await getRevParseCached(gitExec, ctx.repoRoot, 'HEAD')).trim();
   if (forkRef) {
      const resolvedForkRef = (await revParseCached(scopeGit$, forkRef)).trim();
      if (resolvedForkRef) baseCommit = resolvedForkRef;
   } else if (forkBranch) {
      const resolvedForkBranch = (await revParseCached(scopeGit$, forkBranch)).trim();
      if (resolvedForkBranch) baseCommit = resolvedForkBranch;
   }

   // Check for changes
   const statusOutput = (
      await $`${scopeGit$} status --porcelain=v1 --untracked-files=normal`
   ).stdout.trim();
   const hasChanges = statusOutput.length > 0;
   let stashRef: string | null = null;
   let changesOpt: null | string = null;

   if (hasChanges && (moveMode || mirrorMode)) {
      const stashMessage = `git-parallel:${alias}`;
      try {
         if (mirrorMode) {
            const hash = await $`${scopeGit$} stash create --include-untracked`;
            await $`${scopeGit$} stash store -m ${stashMessage} ${hash}`;
            changesOpt = 'mirrored';
         } else if (moveMode) {
            await $`${scopeGit$} stash push --include-untracked -m ${stashMessage}`;
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
         await $inherit`${scopeGit$} worktree add ${forkBranchFlag} ${forkBranch} ${targetPath} ${targetRef}`;
      } else {
         await $inherit`${scopeGit$} worktree add --detach ${targetPath} ${targetRef}`;
      }
   } catch {
      Logger.error('Failed to create the parallel worktree.', 'parallel');
      if (stashRef) {
         await $`${scopeGit$} stash pop ${stashRef}`;
         quickPrint(`${SGR.yellow}Stashed changes restored to the origin worktree.${SGR.reset}`);
      }
      return 1;
   }

   // Apply stashed changes to the new worktree
   if (stashRef) {
      try {
         await $`${scopeGit$} -C ${targetPath} stash apply --index ${stashRef}`;
         await $`${scopeGit$} stash drop ${stashRef}`;
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

   quickPrint(`${SGR.cyan}Parallel worktree created:${SGR.reset} ${targetPath}`);
   if (changesOpt) {
      quickPrint(`${SGR.cyan}Pending changes ${changesOpt} to fork '${alias}'.${SGR.reset}`);
   }

   await runWorktreeInit({
      git$: scopeGit$,
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
      quickPrint(`${SGR.yellow}No forked worktrees found for this branch.${SGR.reset}`);
      return 0;
   }

   const entries = fs.readdirSync(ctx.parallelRoot, { withFileTypes: true });
   const worktrees = entries
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));

   if (worktrees.length === 0) {
      quickPrint(`${SGR.yellow}No forked worktrees found for this branch.${SGR.reset}`);
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
         quickPrint(`${SGR.cyan}Worktree path copied to clipboard!${SGR.reset}`);
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
   quickPrint(`${SGR.cyan}Project:${SGR.reset} ${ctx.projectName}`);
   quickPrint(`${SGR.cyan}Branch:${SGR.reset} ${ctx.branchName}`);
   quickPrint(`${SGR.cyan}Origin:${SGR.reset} ${ctx.originPath}`);
   const currentLabel = ctx.isParallelWorktree ? ctx.alias : 'origin';
   quickPrint(
      `${SGR.cyan}Current:${SGR.reset} ${currentLabel} ${currentLabel !== 'origin' ? SGR.dim + '(use "origin" alias to refer to main worktree)' + SGR.reset : ''}\n`
   );

   if (!fs.existsSync(ctx.parallelRoot)) {
      // LINK: dkn2ika string literal in spec
      quickPrint(`${SGR.yellow}No forked worktrees found for this branch.${SGR.reset}`);
      return 0;
   }

   const entries = fs.readdirSync(ctx.parallelRoot, { withFileTypes: true });
   const worktrees = entries
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));

   if (worktrees.length === 0) {
      quickPrint(`${SGR.yellow}No forked worktrees found for this branch.${SGR.reset}`);
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
      const originHead = (await getRevParseCached(gitExec, ctx.originPath, 'HEAD')).trim();
      const originHeadRef = originHead ? [originHead] : [];
      const maxLogCount = isShortOutput ? 3 : undefined;
      const [statusOutputRaw, comparison, mainLog, submoduleLog] = await Promise.all([
         // get dirty status
         $`${git$} -C ${wtPath} status --porcelain=v1 --untracked-files=normal`.then((r) =>
            r.stdout.trim()
         ),
         // Get commit comparison with origin
         getCommitComparison(git$, wtPath, ctx.originPath, mainRangeStart, originHead),
         mainRangeStart
            ? getCommitRangeLog({
               gitExec,
               repoPath: wtPath,
               range: `${mainRangeStart}..HEAD`,
               maxCount: maxLogCount,
               formatTemplate: `${SGR.yellow}%h${SGR.reset} %s`,
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
         commitInfo = `${SGR.yellow}↑${aheadLabel} ↓${comparison.behind}${SGR.reset}`;
      } else if (hasAhead) {
         commitInfo = `${SGR.green}↑${aheadLabel}${SGR.reset}`;
      } else if (comparison.behind > 0) {
         commitInfo = `${SGR.red}↓${comparison.behind}${SGR.reset}`;
      } else {
         commitInfo = `${SGR.dim}up-to-date${SGR.reset}`;
      }

      const marker = ctx.isParallelWorktree && aliasLabel === ctx.alias ? '●' : '○';
      const statusLabel = isDirty ? `${SGR.red}dirty${SGR.reset}` : `${SGR.green}clean${SGR.reset}`;
      const branchInfo = meta.forkBranch ? `${SGR.dim}(branch:${meta.forkBranch})${SGR.reset}` : '';

      let displayPath = wtPath;
      if (isShortOutput) {
         // Format path with hyperlink and clamp it to reasonable length
         const clampedPath = strClamp(wtPath, 50, 'mid', -1);
         displayPath = hyperlink(clampedPath, `file://${asUnixPath(wtPath)}`);
      }

      spinnerCtrl.stop();
      quickPrint(
         `${SGR.dim}${marker}${SGR.reset} ${strClamp(aliasLabel, 18, 'end')} ${strJustify(statusLabel, 7, { align: 'center' })} ${SGR.dim}${baseShort}${SGR.reset} ${padEnd(commitInfo, 11)} ${displayPath}${branchInfo ? ` ${branchInfo}` : ''}`
      );

      if (baseCommit) {
         if (submoduleLog.groups.length > 0) {
            const groups: CommitGroup[] = [
               {
                  label: `. ${SGR.dim}[main]${SGR.reset}`,
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
      quickPrint(`${SGR.yellow}No forked worktrees found for this branch.${SGR.reset}`);
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
         `${SGR.yellow}Stashed changes restored to fork '${forkAlias}' due to cherry-pick failure.${SGR.reset}`
      );
   } catch (err) {
      quickPrint(
         `${SGR.yellow}Please restore stash '${stashRef}' manually from fork '${forkAlias}'. Automatic pop failed.${SGR.reset}`
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
      `${SGR.yellow}Cherry-pick stopped at commit ${commit}. To resolve conflicts run:${SGR.reset}`
   );
   quickPrint(`${SGR.cyan}${`  git -C "${originPath}" cherry-pick ${commit}`}${SGR.reset}`);
   if (unmergedPaths.length > 0) {
      const quotedPaths = unmergedPaths.map((filePath) =>
         filePath.includes(' ') ? `"${filePath}"` : filePath
      );
      const joinedPaths = quotedPaths.join(' ');
      quickPrint(`${SGR.cyan}${`  git -C "${originPath}" add -- ${joinedPaths}`}${SGR.reset}`);
   } else {
      quickPrint(`${SGR.cyan}${`  git -C "${originPath}" add -A`}${SGR.reset}`);
   }
   quickPrint(`${SGR.cyan}${`  git -C "${originPath}" cherry-pick --continue`}${SGR.reset}`);
   quickPrint(`${SGR.cyan}${`  ${EXECUTABLE_NAME} parallel join ${forkAlias}`}${SGR.reset}`);

   if (stashRef) {
      quickPrint(
         `${SGR.dim}Stashed changes from fork '${forkAlias}' can be applied after join.${SGR.reset}`
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
   spinner?: SpinnerController;
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
      const parent = (await getRevParseCached(gitExec, forkRepoPath, `${commit}^`)).trim();
      if (!parent) return false;
      const originHead = (await getRevParseCached(gitExec, originRepoPath, 'HEAD')).trim();
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
      const parent = (await getRevParseCached(gitExec, forkRepoPath, `${commit}^`)).trim();
      if (!parent) return false;
      const originHead = (await getRevParseCached(gitExec, originRepoPath, 'HEAD')).trim();
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
      .replace(/(\W)(\++)/g, `$1${SGR.green}$2${fgRgb(CATPPUCCIN_VPALETTE.overlay0)}`)
      .replace(/(-+)/g, `${SGR.red}$1${fgRgb(CATPPUCCIN_VPALETTE.overlay0)}`);
   if (trimmedStat.length > 0) {
      lines.push('');
      lines.push(...trimmedStat.split('\n').map((line) => `   ${line}`));
   }

   if (warning) {
      lines.push('');
      lines.push(
         `Warning: ${SGR.yellow + SGR.bright}${warning}${SGR.normal + fgRgb(CATPPUCCIN_VPALETTE.overlay0)}`
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
         `  Note: ${SGR.blue}No changes against origin. This commit will be skipped unless applied.${SGR.normal + fgRgb(CATPPUCCIN_VPALETTE.overlay0)}`
      );
   }

   return lines;
}

function getInteractiveStatusText(options: { isEmpty: boolean; hasConflicts: boolean }): string {
   const { isEmpty, hasConflicts } = options;
   if (isEmpty) {
      return (
         SGR.bgWhite +
         SGR.black +
         SGR.bright +
         ' EMPTY ' +
         SGR.reset +
         fgRgb(CATPPUCCIN_VPALETTE.overlay0) +
         bgRgb(CATPPUCCIN_VPALETTE.base)
      );
   }
   if (hasConflicts) {
      return (
         SGR.bgRed +
         SGR.white +
         SGR.bright +
         ' CONFLICT ' +
         SGR.reset +
         fgRgb(CATPPUCCIN_VPALETTE.overlay0) +
         bgRgb(CATPPUCCIN_VPALETTE.base)
      );
   }
   return (
      SGR.green +
      SGR.white +
      SGR.bright +
      ' CLEAN ' +
      SGR.reset +
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
   const parentHead = (
      await getRevParseCached(gitExec, repoPath, ['-q', '--verify', 'HEAD~1'])
   ).trim();
   if (!parentHead) {
      Logger.error('No commit available to undo.', 'parallel');
      return false;
   }

   try {
      await $`${gitExec} -C ${repoPath} reset --hard HEAD~1`;
      quickPrint(`${SGR.cyan}Undid last cherry-picked commit in ${repoPath}.${SGR.reset}`);
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
   let joinCursorBlocked = false;
   let hasBlockedPendingCommits = false;

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
                  quickPrint(`${SGR.yellow}No commit to undo yet.${SGR.reset}`);
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
               joinCursorBlocked = false;
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
               sourceRepoPath: forkPath,
            });
            if (appliedResult === 'applied') {
               appliedCommits.push(commit);
               appliedIndices.push(index);
            }
            if (appliedResult === 'skipped' || appliedResult === 'empty') {
               joinCursorBlocked = blockJoinCursorAtCommit(
                  meta,
                  forkPath,
                  commit,
                  joinCursorBlocked
               );
               hasBlockedPendingCommits = true;
            } else {
               joinCursorBlocked = updateJoinCursorContiguously(
                  meta,
                  forkPath,
                  commit,
                  mainRangeStart,
                  joinCursorBlocked
               );
            }
         } else if (skipped) {
            joinCursorBlocked = blockJoinCursorAtCommit(meta, forkPath, commit, joinCursorBlocked);
            hasBlockedPendingCommits = true;
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
         const originSubHeadInFork = originSubHead
            ? (
               await getRevParseCached(gitExec, forkSubPath, [
                  '-q',
                  '--verify',
                  `${originSubHead}^{commit}`,
               ])
            ).trim()
            : '';
         const subRevListArgs = [
            '-C',
            forkSubPath,
            'rev-list',
            '--reverse',
            `${subRangeStart}..${subHead}`,
         ];
         if (originSubHeadInFork) {
            subRevListArgs.push('--not', originSubHeadInFork);
         }
         subCommitList = await $`${gitExec} ${subRevListArgs}`.then((res) =>
            res.stdout
               .trim()
               .split('\n')
               .map((c) => c.trim())
               .filter((c) => !!c)
         );
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
      let subCursorBlocked = false;
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
                     quickPrint(`${SGR.yellow}No commit to undo yet.${SGR.reset}`);
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
                  subCursorBlocked = false;
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
                  sourceRepoPath: forkSubPath,
               });
               if (appliedResult === 'applied') {
                  appliedSubmoduleCommits.push(commit);
                  subAppliedIndices.push(subIndex);
               }
               if (appliedResult === 'skipped' || appliedResult === 'empty') {
                  subCursorBlocked = blockSubmoduleCursorAtCommit(
                     meta,
                     forkPath,
                     submodule.path,
                     commit,
                     subCursorBlocked
                  );
                  hasBlockedPendingCommits = true;
               } else if (!subCursorBlocked) {
                  meta.submoduleCursors ??= {};
                  meta.submoduleCursors[submodule.path] = commit || subRangeStart;
                  writeParallelMetadata(forkPath, meta);
               }
            } else if (skipped) {
               subCursorBlocked = blockSubmoduleCursorAtCommit(
                  meta,
                  forkPath,
                  submodule.path,
                  commit,
                  subCursorBlocked
               );
               hasBlockedPendingCommits = true;
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
               `${SGR.yellow}Stashed changes restored to fork '${forkAlias}' for safety.${SGR.reset}`
            );
         } catch (err) {
            quickPrint(
               `${SGR.yellow}Please restore stash '${stashRef}' manually from fork '${forkAlias}'. Automatic pop failed.${SGR.reset}`
            );
            Logger.debug(yuString(err, { color: true }), 'parallel');
         }
         return 1;
      }
   }

   if (appliedCommits.length > 0 || appliedSubmoduleCommits.length > 0) {
      quickPrint(
         `${SGR.cyan}Cherry-picked ${appliedCommits.length} commit(s) into origin.${SGR.reset}`
      );
      if (appliedSubmoduleCommits.length > 0) {
         quickPrint(
            `${SGR.cyan}Cherry-picked ${appliedSubmoduleCommits.length} submodule commit(s) into origin.${SGR.reset}`
         );
      }
   } else {
      quickPrint(
         `${SGR.cyan}No new commits to cherry-pick. Origin was already up to date.${SGR.reset}`
      );
   }

   if (
      !keep &&
      !hasBlockedPendingCommits &&
      (appliedCommits.length > 0 || appliedSubmoduleCommits.length > 0)
   ) {
      Logger.debug(`Removing fork worktree '${forkAlias}' after join...`, 'parallel');
      const removeResult = await removeWorktree(git$, forkAlias);
      if (removeResult !== 0) {
         Logger.warn(
            `Failed to remove fork '${forkAlias}' after joining. Please remove it manually later.`
         );
         return 1;
      }
      quickPrint(`${SGR.cyan}Fork '${forkAlias}' merged and removed successfully.${SGR.reset}`);
   } else {
      if (!hasBlockedPendingCommits) {
         try {
            const newBase = (await getRevParseCached(gitExec, originPath, 'HEAD')).trim();
            if (newBase) {
               resetParallelJoinState(meta, newBase);
            }
         } catch {
            // Ignore metadata update errors
         }
      } else {
         meta.updatedAt = new Date().toISOString();
      }
      writeParallelMetadata(forkPath, meta);
      quickPrint(
         `${SGR.cyan}Fork '${forkAlias}' merged into origin. Worktree kept at:${SGR.reset} ${forkPath}`
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
      quickPrint(`${SGR.yellow}No forked worktrees found for this branch.${SGR.reset}`);
      return 0;
   }

   const entries = fs.readdirSync(ctx.parallelRoot, { withFileTypes: true });
   const worktrees = entries
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));

   if (worktrees.length === 0) {
      quickPrint(`${SGR.yellow}No forked worktrees found for this branch.${SGR.reset}`);
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
      quickPrint(`${SGR.yellow}No forked worktrees found for this branch.${SGR.reset}`);
   }

   return 0;
}

/**
 * Join command - merges a parallel worktree back to origin
 */
async function cmdJoin(git$: string | string[], args: ArgsSet): Promise<number> {
   let scope: Awaited<ReturnType<typeof getParallelScope>>;
   try {
      scope = await getParallelScope(git$);
   } catch (err) {
      Logger.error(yuString(err, { color: true }), 'parallel');
      return 1;
   }

   const ctx = scope.parallelCtx;
   const scopeGit$ = scope.scopeGit$;

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
      return await cmdJoinRecursive(scopeGit$, ctx, keep);
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
      if (scope.currentLabel === 'origin') {
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

      forkAlias = scope.currentLabel;
      forkPath = resolveParallelWorktreePath(ctx, forkAlias);
   }

   return await joinWorktree(scopeGit$, forkPath, forkAlias, { keep, bringAll, interactive });
}

async function cmdSync(git$: string | string[], args: ArgsSet): Promise<number> {
   let scope: Awaited<ReturnType<typeof getParallelScope>>;
   try {
      scope = await getParallelScope(git$);
   } catch (err) {
      Logger.error(yuString(err, { color: true }), 'parallel');
      return 1;
   }

   const validFlags = ['--hard', '-h'];
   const flags = new Set<string>();
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

   const hard = flags.has('--hard') || flags.has('-h');
   const ctx = scope.parallelCtx;

   let forkAlias: string;
   let forkPath: string;
   if (targetAlias) {
      if (targetAlias === 'origin') {
         Logger.error('Origin is already the synchronization source.', 'parallel');
         return 1;
      }
      if (!testParallelAlias(targetAlias)) {
         Logger.error(`Alias '${targetAlias}' contains invalid characters or spaces.`, 'parallel');
         return 1;
      }

      forkAlias = targetAlias;
      forkPath = resolveParallelWorktreePath(ctx, forkAlias);
      if (!fs.existsSync(forkPath)) {
         Logger.error(
            `Worktree '${forkAlias}' not found for branch '${ctx.branchName}'.`,
            'parallel'
         );
         return 1;
      }
   } else {
      if (scope.currentLabel === 'origin') {
         Logger.error(
            'Run sync from inside a forked worktree, or specify which fork to sync.',
            'parallel'
         );
         return 1;
      }

      forkAlias = scope.currentLabel;
      forkPath = ctx.repoRoot;
   }

   const meta = getParallelMetadata(forkPath);
   if (!meta) {
      Logger.error(`Missing metadata for worktree '${forkAlias}'.`, 'parallel');
      return 1;
   }

   const originPath = path.resolve(meta.originPath);
   if (!fs.existsSync(originPath)) {
      Logger.error(`Origin worktree path not found at '${originPath}'.`, 'parallel');
      return 1;
   }

   const cleanTarget = await ensureCleanWorktreeOrClear(scope.gitExec, forkPath, hard);
   if (!cleanTarget) {
      Logger.error(
         `Fork '${forkAlias}' has uncommitted changes. Re-run with --hard to clear them first.`,
         'parallel'
      );
      return 1;
   }

   const originHead = (await getRevParseCached(scope.gitExec, originPath, 'HEAD')).trim();
   if (!originHead) {
      Logger.error('Unable to resolve origin HEAD for sync.', 'parallel');
      return 1;
   }

   try {
      if (meta.forkBranch && meta.forkBranchTracked) {
         const mergeArgs = ['-C', forkPath, 'merge', '--no-edit', '-X', 'theirs', originHead];
         const result = await $`${scope.gitExec} ${mergeArgs}`;
         printGitResult(result);
      } else {
         const result = await $`${scope.gitExec} -C ${forkPath} reset --hard ${originHead}`;
         printGitResult(result);
      }
   } catch (err) {
      printGitResult(getGitErrorOutput(err));
      try {
         await $`${scope.gitExec} -C ${forkPath} merge --abort`;
      } catch {
         // ignore if no merge is active
      }
      Logger.error(`Failed to sync fork '${forkAlias}' with origin.`, 'parallel');
      Logger.debug(yuString(err, { color: true }), 'parallel');
      return 1;
   }

   try {
      await refreshParallelSubmodules(scope.gitExec, forkPath, hard);
   } catch (err) {
      Logger.error(`Failed to refresh submodules for '${forkAlias}' after sync.`, 'parallel');
      Logger.debug(yuString(err, { color: true }), 'parallel');
      return 1;
   }

   const syncedHead =
      (await getRevParseCached(scope.gitExec, forkPath, 'HEAD')).trim() || originHead;
   resetParallelJoinState(meta, syncedHead);
   writeParallelMetadata(forkPath, meta);

   quickPrint(`${SGR.cyan}Fork '${forkAlias}' synchronized with origin.${SGR.reset}`);
   return 0;
}

async function cmdPick(git$: string | string[], args: ArgsSet): Promise<number> {
   let scope: Awaited<ReturnType<typeof getParallelScope>>;
   try {
      scope = await getParallelScope(git$);
   } catch (err) {
      Logger.error(yuString(err, { color: true }), 'parallel');
      return 1;
   }

   if (args.length < 2) {
      Logger.error('Usage: gdx parallel pick <alias|origin> <commit> [commit...]', 'parallel');
      showUsage();
      return 1;
   }

   const sourceAlias = args[0];
   const commitArgs = args.slice(1).filter((arg) => arg.length > 0);
   if (sourceAlias !== 'origin' && !testParallelAlias(sourceAlias)) {
      Logger.error(`Alias '${sourceAlias}' contains invalid characters or spaces.`, 'parallel');
      return 1;
   }

   const sourceWorktreePath = resolveParallelWorktreePath(scope.parallelCtx, sourceAlias);
   const targetWorktreePath = scope.parallelCtx.repoRoot;

   if (!fs.existsSync(sourceWorktreePath)) {
      Logger.error(
         `Worktree '${sourceAlias}' not found for branch '${scope.parallelCtx.branchName}'.`,
         'parallel'
      );
      return 1;
   }

   if (path.resolve(sourceWorktreePath) === path.resolve(targetWorktreePath)) {
      Logger.error('Source and destination worktrees are the same.', 'parallel');
      return 1;
   }

   const sourceRepoPath = scope.submodulePath
      ? path.resolve(sourceWorktreePath, scope.submodulePath)
      : sourceWorktreePath;
   const targetRepoPath = scope.repoRoot;

   if (!fs.existsSync(sourceRepoPath)) {
      Logger.error(
         `Submodule '${scope.submodulePath}' is not available in worktree '${sourceAlias}'.`,
         'parallel'
      );
      return 1;
   }

   const resolvedCommits: string[] = [];
   for (const commit of commitArgs) {
      try {
         const resolved = (
            await getRevParseCached(scope.gitExec, sourceRepoPath, [
               '-q',
               '--verify',
               `${commit}^{commit}`,
            ])
         ).trim();
         if (!resolved) {
            Logger.error(`Commit '${commit}' was not found in '${sourceAlias}'.`, 'parallel');
            return 1;
         }
         resolvedCommits.push(resolved);
      } catch {
         Logger.error(`Commit '${commit}' was not found in '${sourceAlias}'.`, 'parallel');
         return 1;
      }
   }

   if (scope.submodulePath) {
      try {
         await $`${scope.gitExec} -c protocol.file.allow=always -C ${targetRepoPath} fetch ${sourceRepoPath} ${resolvedCommits}`;
      } catch (err) {
         Logger.error(
            `Failed to fetch commits from submodule '${scope.submodulePath}' in '${sourceAlias}'.`,
            'parallel'
         );
         Logger.debug(yuString(err, { color: true }), 'parallel');
         return 1;
      }
   }

   for (const commit of resolvedCommits) {
      try {
         const identityArgs = await getCherryPickIdentityArgs(
            scope.gitExec,
            targetRepoPath,
            sourceRepoPath,
            commit
         );
         const result =
            await $`${scope.gitExec} ${identityArgs} ${forceColorArgs()} -C ${targetRepoPath} cherry-pick ${commit}`;
         printGitResult(result);
      } catch (err) {
         const wasEmpty = await skipEmptyCherryPick(
            scope.gitExec,
            targetRepoPath,
            err,
            'parallel pick'
         );
         if (wasEmpty) {
            continue;
         }

         printGitResult(getGitErrorOutput(err));
         Logger.error(`Failed to cherry-pick commit ${commit} from '${sourceAlias}'.`, 'parallel');
         Logger.debug(yuString(err, { color: true }), 'parallel');
         return 1;
      }
   }

   quickPrint(
      `${SGR.cyan}Cherry-picked ${resolvedCommits.length} commit(s) from '${sourceAlias}' into ${scope.currentLabel}.${SGR.reset}`
   );
   return 0;
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
      sourceRepoPath?: string;
   }
): Promise<'applied' | 'skipped' | 'empty'> {
   const { originRepoPath, commit, contextLabel, forkAlias, stashRef, sourceRepoPath } = ctx;
   Logger.debug(`Cherry-picking commit ${commit} into ${contextLabel}...`, 'parallel');
   const colorArgs = forceColorArgs();
   const gitExec = Array.isArray(git$) ? git$[0] : git$;
   const identityArgs = sourceRepoPath
      ? await getCherryPickIdentityArgs(gitExec, originRepoPath, sourceRepoPath, commit)
      : [];
   try {
      const result =
         await $`${gitExec} ${identityArgs} ${colorArgs} -C ${originRepoPath} cherry-pick ${commit}`;
      printGitResult(result);
      return 'applied';
   } catch (err) {
      const shouldSkip = await skipEmptyCherryPick(git$, originRepoPath, err, contextLabel);
      if (shouldSkip) return 'empty';

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
         `${SGR.yellow}Cherry-pick paused due to conflicts while applying commit ${commit}.${SGR.reset}`
      );
      quickPrint(
         `${SGR.dim}Resolve conflicts in ${contextLabel}, then choose to continue or abort.${SGR.reset}`
      );

      while (true) {
         const response = (
            await $prompt('Type c to continue, a to abort, s to skip (c|a|s): ')
         ).toLowerCase();

         switch (response) {
            case 's':
            case 'skip':
               try {
                  await $`${gitExec} ${identityArgs} ${colorArgs} -C ${originRepoPath} cherry-pick --skip`;
                  Logger.debug(`Skipped commit ${commit} for ${contextLabel}.`, 'parallel');
                  return 'skipped';
               } catch (skipErr) {
                  const stillInProgress = await hasCherryPickInProgress(git$, originRepoPath);
                  if (!stillInProgress) return 'skipped';

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
                     await $`${gitExec} ${identityArgs} ${colorArgs} -C ${originRepoPath} cherry-pick --continue`;
                  printGitResult(result);
                  return 'applied';
               } catch (continueErr) {
                  const shouldSkip = await skipEmptyCherryPick(
                     git$,
                     originRepoPath,
                     continueErr,
                     contextLabel
                  );
                  if (shouldSkip) return 'empty';

                  printGitResult(getGitErrorOutput(continueErr));

                  const stillInProgress = await hasCherryPickInProgress(git$, originRepoPath);
                  if (stillInProgress) {
                     quickPrint(
                        `${SGR.yellow}Cherry-pick still has conflicts. Resolve them and try again.${SGR.reset}`
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
                     await $`${gitExec} ${identityArgs} ${colorArgs} -C ${originRepoPath} cherry-pick --abort`;
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
   baseCommit?: string,
   originHeadInput?: string
): Promise<{ ahead: number; behind: number }> {
   const gitExec = Array.isArray(git$) ? git$[0] : git$;
   try {
      // Get HEAD of both worktrees
      const [wtHead, resolvedOriginHead] = await Promise.all([
         getRevParseCached(gitExec, worktreePath, 'HEAD').then((r) => r.trim()),
         originHeadInput !== undefined
            ? Promise.resolve(originHeadInput.trim())
            : getRevParseCached(gitExec, originPath, 'HEAD').then((r) => r.trim()),
      ]);
      const originHead = resolvedOriginHead;

      if (wtHead === originHead) {
         return { ahead: 0, behind: 0 };
      }

      let ahead = 0;
      let behind = 0;
      await Promise.all([
         (async () => {
            // Count commits ahead (in worktree but not in origin/base)
            try {
               const rangeStart = baseCommit || originHead;
               const aheadOutput = (
                  await $`${gitExec} -C ${worktreePath} rev-list --count ${rangeStart}..${wtHead}`
               ).stdout.trim();
               ahead = parseInt(aheadOutput, 10) || 0;
            } catch {
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
   spinner?: SpinnerController
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
         formatTemplate: `${SGR.yellow}%h${SGR.reset} %s`,
         excludeRefs: originSubHead ? [originSubHead] : undefined,
      });

      if (logResult.totalCount === 0) continue;
      const label = `${submodule.path} ${SGR.dim}[submodule]${SGR.reset}`;
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
      renderedLines.push(`${SGR.dim}+${moreCount} more${SGR.reset}`);
   }
   if (renderedLines.length === 0) return;

   for (let i = 0; i < renderedLines.length; i++) {
      const isLast = i === renderedLines.length - 1;
      const connector = isLast ? '└─ ' : '├─ ';
      quickPrint(`${SGR.dim}${prefix}${connector}${SGR.reset}${renderedLines[i]}`);
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
      quickPrint(`${SGR.dim}${groupConnector}${SGR.reset}${group.label}`);

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
      'sync',
      'pick',
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
      case 'sync':
         return await cmdSync(git$, remaining);
      case 'pick':
         return await cmdPick(git$, remaining);
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
      return strWrap(
         litedent`
         ${SGR.bright + _2PointGradient('PARALLEL', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         Manage parallel (forked) worktrees for iterative development.

         ${SGR.bright + _2PointGradient('OVERVIEW', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         \`${SGR.cyan}${EXECUTABLE_NAME} parallel${SGR.reset}\` helps you create and manage temporary forked worktrees for the current branch. Forked worktrees live under a temp worktree root and contain a small metadata file (.git-parallel.json) so the tool can later join, list or remove them cleanly.

         Additionally, \`${SGR.cyan}${EXECUTABLE_NAME} parallel fork${SGR.reset}\` can auto-initialize submodules,
         copy ignored env files, and install dependencies using detected package managers (currently supports
         npm, pnpm, bun, and uv) if configured (see \`${SGR.cyan}parallel.init${SGR.reset}\` and
         \`${SGR.cyan}parallel.envPaths${SGR.reset}\` config for options), getting the fork ready for work in no time.

         ${SGR.bright + _2PointGradient('SUBCOMMANDS AND BEHAVIOR', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         - ${SGR.cyan}fork <alias>${SGR.reset}: Creates a detached worktree in a safe temporary namespace. Use \`${SGR.cyan}-b${SGR.reset}\` or \`${SGR.cyan}-B${SGR.reset}\` to create a non-detached worktree that tracks a local branch. If pending changes exist and you run with \`${SGR.cyan}--move${SGR.reset}\` or \`${SGR.cyan}--mirror${SGR.reset}\`, changes will be moved/applied to the fork. Init behaviors (submodules, env file copy, packages) are controlled by config and \`${SGR.cyan}--no-init${SGR.reset}\`.
         - ${SGR.cyan}join [<alias>] [--keep|--all|-i|--interactive]${SGR.reset}: Cherry-picks commits from the fork back into the origin worktree. \`${SGR.cyan}--keep${SGR.reset}\` retains the fork and updates its base; \`${SGR.cyan}--all${SGR.reset}\` also includes uncommitted changes. \`${SGR.cyan}--interactive${SGR.reset}\` previews and lets you choose each commit before applying.
         - ${SGR.cyan}join -r|--recursive [--keep]${SGR.reset}: Joins every fork for the current branch back into origin. Recursive join does not allow \`${SGR.cyan}--all${SGR.reset}\`.
         - ${SGR.cyan}sync [<alias>] [--hard|-h]${SGR.reset}: Synchronizes a fork with origin. Detached forks move to origin HEAD; branch-tracked forks merge origin into the fork and prefer origin changes on conflicts. \`${SGR.cyan}--hard${SGR.reset}\` clears fork-local changes before syncing.
         - ${SGR.cyan}pick <alias|origin> <commit> [commit...]${SGR.reset}: Cherry-picks commits from another worktree into the current worktree. When run inside a submodule, it targets the same submodule path in the source worktree.
         - ${SGR.cyan}list${SGR.reset}: Lists forks for the current branch with status, base commit, divergence and recent commits. Use ${SGR.cyan}--short${SGR.reset} for compact output.
         - ${SGR.cyan}remove <alias>${SGR.reset}: Removes the forked worktree and cleans up the directory.
         - ${SGR.cyan}remove -r|--recursive${SGR.reset}: Removes every fork for the current branch.

         ${SGR.bright + _2PointGradient('SAFETY AND NOTES', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
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
      return strWrap(
         litedent`
         ${SGR.cyan}${EXECUTABLE_NAME} parallel fork ${SGR.dim}<alias> [ref] [-b|-B <branch>] [--move|--mirror] [--no-init[=submodule,env,pkg]]${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} parallel list${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} parallel open ${SGR.dim}<alias|origin> [-c|--copy]${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} parallel switch ${SGR.dim}<alias|origin> [-c|--copy]${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} parallel sync ${SGR.dim}[<alias>] [--hard|-h]${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} parallel pick ${SGR.dim}<alias|origin> <commit> [commit...]${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} parallel join ${SGR.dim}<alias> [--keep|--all|-i|--interactive]${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} parallel join ${SGR.dim}-r|--recursive [--keep]${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} parallel remove ${SGR.dim}<alias>${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} parallel remove ${SGR.dim}-r|--recursive${SGR.reset}

         Examples:
            ${SGR.cyan}${EXECUTABLE_NAME} parallel fork feature-x --move ${SGR.reset + SGR.dim}# Create fork and optionally move changes${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} parallel fork feature-x deadbeef ${SGR.reset + SGR.dim}# Create fork from a ref${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} parallel fork feature-x -b feature-x ${SGR.reset + SGR.dim}# Create fork on a local branch${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} parallel fork feature-x -B feature-x ${SGR.reset + SGR.dim}# Recreate the fork branch${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} parallel fork feature-x --no-init ${SGR.reset + SGR.dim}# Skip all init behaviors${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} parallel fork feature-x --no-init=pkg ${SGR.reset + SGR.dim}# Skip package installs only${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} parallel fork feature-x --no-init=env ${SGR.reset + SGR.dim}# Skip env file copy${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} parallel list --short ${SGR.reset + SGR.dim}# Compact output with recent commits${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} parallel sync feature-x --hard ${SGR.reset + SGR.dim}# Reset a fork to the latest origin state${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} parallel pick origin deadbeef ${SGR.reset + SGR.dim}# Cherry-pick from origin into current worktree${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} parallel join feature-x --all ${SGR.reset + SGR.dim}# Merge fork back into origin${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} parallel join feature-x -i ${SGR.reset + SGR.dim}# Preview and pick commits${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} parallel join -r ${SGR.reset + SGR.dim}# Merge all forks back into origin${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} parallel remove -r ${SGR.reset + SGR.dim}# Remove all forks for this branch${SGR.reset}`,
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
      sync: parallelSyncStructure,
      pick: parallelPickStructure,
      join: parallelJoinStructure,
      remove: parallelRemoveStructure,
      help: {},
   },
} as const satisfies CommandStructure;

function showUsage(): void {
   quickPrint(help.short + '\n' + help.usage());
}
