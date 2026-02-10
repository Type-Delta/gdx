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
} from '@/modules/shell';
import { normalizePath, quickPrint } from '@/utils/utilities';
import Logger from '@/utils/logger';
import { createOptionChildren, createOptionChildrenWithFlags } from '@/utils/structure';
import { EXECUTABLE_NAME, GDX_RESULT_FILE, TEMP_DIR, COLOR } from '@/consts';
import { _2PointGradient } from '@/modules/graphics';
import global from '@/global';
import {
   deinitSubmodules,
   getDirtySubmodules,
   getSubmodules,
   getWorktreeEntry,
   getWorktreeOperations,
   hasCherryPickInProgress,
   invalidateWorktreeListCache,
   normalizeStatusPath,
   getRepoRootCached,
   pruneWorktrees,
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
      $allOf: ['--keep', '--all'],
      '-r': { $allOf: ['--keep'] },
      '--recursive': { $allOf: ['--keep'] },
      ...createOptionChildrenWithFlags(aliases, ['--keep', '--all']),
   };
};

const parallelRemoveStructure: CommandArgThunk = async ({ git$ }) => {
   const aliases = await listParallelAliases(git$);
   return createOptionChildren(aliases);
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
      return JSON.parse(content);
   } catch {
      return null;
   }
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

   const targetPath = path.join(ctx.parallelRoot, alias);

   await invalidateWorktreeListCache(git$);
   const worktreeEntry = await getWorktreeEntry(git$, targetPath);
   if (!worktreeEntry && !fs.existsSync(targetPath)) {
      Logger.error(`Worktree '${alias}' not found for branch '${ctx.branchName}'.`, 'parallel');
      return 1;
   }

   if (worktreeEntry?.locked) {
      const reason = worktreeEntry.lockReason ? ` (${worktreeEntry.lockReason})` : '';
      Logger.error(
         `Worktree '${alias}' is locked ${reason}. Unlock it before removing.`,
         'parallel'
      );
      return 1;
   }

   if (!fs.existsSync(targetPath)) {
      await pruneWorktrees(git$);
      const afterPrune = await getWorktreeEntry(git$, targetPath);
      if (!afterPrune) {
         quickPrint(`${ncc('Cyan')}Removed worktree metadata:${ncc()} ${alias}`);
         return 0;
      }

      Logger.error(`Worktree '${alias}' is missing on disk and could not be pruned.`, 'parallel');
      return 1;
   }

   try {
      fs.accessSync(targetPath, fs.constants.F_OK | fs.constants.W_OK);
   } catch {
      Logger.error(`Worktree '${alias}' is not accessible or writable. Cannot remove.`, 'parallel');
      return 1;
   }

   const activeOps = await getWorktreeOperations(git$, targetPath);
   if (activeOps.length > 0) {
      Logger.error(
         `Worktree '${alias}' has in-progress operations (${activeOps.join(', ')}). Complete or abort them before removing.`,
         'parallel'
      );
      return 1;
   }

   const submodules = await getSubmodules(git$, targetPath);
   if (submodules.length > 0) {
      const dirtySubmodules = await getDirtySubmodules(git$, targetPath, submodules);
      if (dirtySubmodules.length > 0) {
         const detail = dirtySubmodules.join(', ');
         Logger.error(
            `Worktree '${alias}' has dirty submodules (${detail}). Commit, stash, or clean them before removing.`,
            'parallel'
         );
         return 1;
      }

      try {
         await deinitSubmodules(git$, targetPath);
      } catch (err) {
         const fallbackStatus = (
            await $`${git$} -C ${targetPath} status --porcelain=v1 --untracked-files=normal`
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

   const statusOutput = (
      await $`${git$} -C ${targetPath} status --porcelain=v1 --untracked-files=normal`
   ).stdout.trim();
   if (statusOutput.length > 0) {
      if (submodules.length > 0) {
         const submodulePaths = new Set(
            submodules.map((submodule) => normalizeStatusPath(submodule.path))
         );
         const statusPaths = statusOutput
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map((line) => line.slice(3))
            .map((rawPath) => rawPath.split(' -> ').pop() ?? rawPath)
            .map((rawPath) => normalizeStatusPath(rawPath));

         const dirtySubmodules = statusPaths.filter((statusPath) => submodulePaths.has(statusPath));
         if (dirtySubmodules.length > 0) {
            Logger.error(
               `Worktree '${alias}' has dirty submodules (${dirtySubmodules.join(', ')}). Commit, stash, or clean them before removing.`,
               'parallel'
            );
            return 1;
         }
      }

      Logger.error(
         `Worktree '${alias}' has uncommitted changes. Join or clean it before removing.`,
         'parallel'
      );
      return 1;
   }

   quickPrint('');
   const spinnerCtrl = spinner({
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
   });

   try {
      const result = await $`${git$} worktree remove ${targetPath}`;
      spinnerCtrl.stop();

      quickPrint(result.stdout.trim());

      // Clean up directory if it still exists
      try {
         fs.rmSync(targetPath, { recursive: true, force: true });
      } catch {
         // Ignore cleanup errors
      }

      // LINK: dw2al2m string literal in spec
      quickPrint(`\n${ncc('Cyan')}Removed worktree:${ncc()} ${alias}`);
      return 0;
   } catch (err) {
      spinnerCtrl.stop();
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

   if (parsedArgs.hasOption('--no-init')) {
      noInitList = parsedArgs.popValue('--no-init', 0, true);
      if (noInitList === null) {
         noInitAll = true;
      }
   }

   const targetPath = path.join(ctx.parallelRoot, alias);
   const moveMode = parsedArgs.includes('--move') || parsedArgs.includes('-mv');
   const mirrorMode = parsedArgs.includes('--mirror') || parsedArgs.includes('-mr');

   const unknownArgs = parsedArgs.filter(
      (arg) => !['--move', '--mirror', '-mv', '-mr'].includes(arg)
   );
   if (unknownArgs.length > 0) {
      Logger.error(`Unknown option '${unknownArgs[0]}'.`, 'parallel');
      showUsage();
      return 1;
   }

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
         Logger.error('Failed to stash changes before forking.', 'parallel');
         return 1;
      }
   }

   // Create worktree
   try {
      await $inherit`${git$} worktree add --detach ${targetPath} HEAD`;
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
   fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2), 'utf-8');

   quickPrint(`${ncc('Cyan')}Parallel worktree created:${ncc()} ${targetPath}`);
   if (changesOpt) {
      quickPrint(`${ncc('Cyan')}Pending changes ${changesOpt} to fork '${alias}'.${ncc()}`);
   }

   await runWorktreeInit({
      git$,
      worktreePath: targetPath,
      noInitAll,
      noInitList,
   });

   return 0;
}

/**
 * Remove command - removes a parallel worktree
 */
async function cmdRemove(git$: string | string[], args: ArgsSet): Promise<number> {
   if (args.length < 1) {
      Logger.error('Missing worktree alias to remove.', 'parallel');
      showUsage();
      return 1;
   }

   const alias = args[0];
   if (!testParallelAlias(alias)) {
      Logger.error(`Alias '${alias}' contains invalid characters or spaces.`, 'parallel');
      return 1;
   }

   const ctx = await getParallelContext(git$);
   if (!ctx) return 1;

   const targetPath = path.join(ctx.parallelRoot, alias);

   if (path.resolve(ctx.repoRoot) === path.resolve(targetPath)) {
      Logger.error(
         'Cannot remove the worktree you are currently in. Switch to origin first.',
         'parallel'
      );
      return 1;
   }

   return await removeWorktree(git$, alias);
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
 * Compares two worktrees and returns commits ahead/behind
 */
async function getCommitComparison(
   git$: string | string[],
   worktreePath: string,
   originPath: string
): Promise<{ ahead: number; behind: number }> {
   const gitExec = Array.isArray(git$) ? git$[0] : git$;
   try {
      // Get HEAD of both worktrees
      const [wtHead, originHead] = await Promise.all([
         $`${gitExec} -C ${worktreePath} rev-parse HEAD`.then((r) => r.stdout.trim()),
         $`${gitExec} -C ${originPath} rev-parse HEAD`.then((r) => r.stdout.trim()),
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
               const aheadOutput = (
                  await $`${gitExec} -C ${worktreePath} rev-list --count ${originHead}..${wtHead}`
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
      if (!meta) continue; // Skip invalid worktrees

      const aliasLabel = meta?.alias || wt.name;
      const baseCommit = meta.baseCommit?.trim();
      hasAnyWt = true;

      const [statusOutput, comparison] = await Promise.all([
         // get dirty status
         $`${git$} -C ${wtPath} status --porcelain=v1 --untracked-files=normal`.then((r) =>
            r.stdout.trim()
         ),
         // Get commit comparison with origin
         getCommitComparison(git$, wtPath, ctx.originPath),
      ]);

      const isDirty = statusOutput.length > 0;
      const baseShort = baseCommit.slice(0, 7);

      let commitInfo = '';
      if (comparison.ahead > 0 && comparison.behind > 0) {
         commitInfo = `${ncc('Yellow')}↑${comparison.ahead} ↓${comparison.behind}${ncc()}`;
      } else if (comparison.ahead > 0) {
         commitInfo = `${ncc('Green')}↑${comparison.ahead}${ncc()}`;
      } else if (comparison.behind > 0) {
         commitInfo = `${ncc('Red')}↓${comparison.behind}${ncc()}`;
      } else {
         commitInfo = `${ncc('Dim')}up-to-date${ncc()}`;
      }

      const marker = ctx.isParallelWorktree && aliasLabel === ctx.alias ? '●' : '○';
      const statusLabel = isDirty ? `${ncc('Red')}dirty${ncc()}` : `${ncc('Green')}clean${ncc()}`;

      let displayPath = wtPath;
      if (isShortOutput) {
         // Format path with hyperlink and clamp it to reasonable length
         const clampedPath = strClamp(wtPath, 50, 'mid', -1);
         displayPath = hyperLink(clampedPath, `file://${wtPath.replace(/\\/g, '/')}`);
      }

      quickPrint(
         `${ncc('Dim')}${marker}${ncc()} ${strClamp(aliasLabel, 18, 'end')} ${strJustify(statusLabel, 7, { align: 'center' })} ${ncc('Dim')}${baseShort}${ncc()} ${padEnd(commitInfo, 11)} ${displayPath}`
      );

      if (baseCommit) {
         let commitCount = 0;
         try {
            const countOutput = (
               await $`${gitExec} -C ${wtPath} rev-list --count ${baseCommit}..HEAD`
            ).stdout.trim();
            commitCount = parseInt(countOutput, 10) || 0;
         } catch {
            commitCount = 0;
         }

         if (commitCount > 0) {
            const maxCount = isShortOutput ? Math.min(3, commitCount) : commitCount;
            let logOutput = '';
            try {
               const logArgs = [
                  '-C',
                  wtPath,
                  'log',
                  `--pretty=format:${ncc('Yellow')}%h${ncc()} %s`,
               ];
               if (isShortOutput) logArgs.push(`--max-count=${maxCount}`);
               logArgs.push(`${baseCommit}..HEAD`);
               logOutput = (await $`${gitExec} ${logArgs}`).stdout.trim();
            } catch {
               logOutput = '';
            }

            const commitLines = logOutput
               .split('\n')
               .map((line) => line.trim())
               .filter((line) => line.length > 0);
            const moreCount = Math.max(commitCount - commitLines.length, 0);
            const connectorMid = `${ncc('Dim')}  ├─ ${ncc()}`;
            const connectorLast = `${ncc('Dim')}  └─ ${ncc()}`;

            for (let i = 0; i < commitLines.length; i++) {
               const isLast = i === commitLines.length - 1;
               const connector = isLast && moreCount === 0 ? connectorLast : connectorMid;
               quickPrint(`${connector}${commitLines[i]}`);
            }

            if (moreCount > 0) {
               quickPrint(`${connectorLast}${ncc('Dim')}+${moreCount} more${ncc()}`);
            }
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

async function getUnmergedPaths(git$: string | string[], originPath: string): Promise<string[]> {
   try {
      const output = (await $`${git$} -C ${originPath} diff --name-only --diff-filter=U`).stdout;
      return output
         .split('\n')
         .map((line) => line.trim())
         .filter((line) => line.length > 0);
   } catch {
      return [];
   }
}

async function stageResolvedConflicts(git$: string | string[], originPath: string): Promise<void> {
   const unmergedPaths = await getUnmergedPaths(git$, originPath);
   if (unmergedPaths.length === 0) return;

   const addArgs = ['-C', originPath, 'add', '-A', '--', ...unmergedPaths];
   await $inherit`${git$} ${addArgs}`;
}

function printCherryPickSteps(
   originPath: string,
   forkAlias: string,
   commit: string,
   stashRef: string | null,
   unmergedPaths: string[]
): void {
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

async function joinWorktree(
   git$: string | string[],
   forkPath: string,
   forkAlias: string,
   options: { keep: boolean; bringAll: boolean }
): Promise<number> {
   const { keep, bringAll } = options;
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

   // Check fork status
   const forkStatus = (
      await $`${git$} -C ${forkPath} status --porcelain=v1 --untracked-files=normal`
   ).stdout.trim();
   const forkDirty = forkStatus.length > 0;

   if (forkDirty && !bringAll) {
      Logger.error(
         `Fork '${forkAlias}' has uncommitted changes. Re-run with --all to include them or clean the worktree first.`,
         'parallel'
      );
      return 1;
   }

   // Check origin status
   const originStatus = (
      await $`${git$} -C ${originPath} status --porcelain=v1 --untracked-files=normal`
   ).stdout.trim();
   if (originStatus.length > 0) {
      Logger.error(
         'Origin worktree has pending changes. Commit or stash them before joining.',
         'parallel'
      );
      return 1;
   }

   const baseCommit = meta.baseCommit?.trim();
   if (!baseCommit) {
      Logger.error(
         'Fork metadata is missing base commit information. Unable to perform an automatic join.',
         'parallel'
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
         Logger.error('Failed to stash uncommitted changes before joining.', 'parallel');
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
   } catch (err) {
      if (stashRef) {
         await $`${git$} -C ${forkPath} stash pop ${stashRef}`;
      }
      Logger.error('Unable to enumerate commits to join.', 'parallel');
      Logger.debug(yuString(err, { color: true }), 'parallel');
      return 1;
   }

   const appliedCommits: string[] = [];

   for (const commit of commitList) {
      if (!commit) continue;

      try {
         await $inherit`${git$} -C ${originPath} cherry-pick ${commit}`;
         appliedCommits.push(commit);
      } catch (err) {
         const hasInProgress = await hasCherryPickInProgress(git$, originPath);
         if (!hasInProgress) {
            if (stashRef) {
               await restoreJoinStash(git$, forkPath, forkAlias, stashRef);
            }
            Logger.error(`Cherry-pick failed while applying commit ${commit}.`, 'parallel');
            Logger.debug(yuString(err, { color: true }), 'parallel');
            return 1;
         }

         if (!isTTY()) {
            const unmergedPaths = await getUnmergedPaths(git$, originPath);
            printCherryPickSteps(originPath, forkAlias, commit, stashRef, unmergedPaths);
            Logger.debug(yuString(err, { color: true }), 'parallel');
            return 1;
         }

         quickPrint(
            `${ncc('Yellow')}Cherry-pick paused due to conflicts while applying commit ${commit}.${ncc()}`
         );
         quickPrint(
            `${ncc('Dim')}Resolve conflicts in the origin worktree, then choose to continue or abort.${ncc()}`
         );

         while (true) {
            const response = (
               await $prompt('Type c to continue, a to abort (c|a): ')
            ).toLowerCase();

            if (
               response === 'c' ||
               response === 'continue' ||
               response === 'y' ||
               response === 'yes'
            ) {
               try {
                  await stageResolvedConflicts(git$, originPath);
                  await $inherit`${git$} -C ${originPath} cherry-pick --continue`;
                  appliedCommits.push(commit);
                  break;
               } catch (continueErr) {
                  const stillInProgress = await hasCherryPickInProgress(git$, originPath);
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
                  return 1;
               }
            }

            if (response === 'a' || response === 'abort' || response === 'n' || response === 'no') {
               try {
                  await $inherit`${git$} -C ${originPath} cherry-pick --abort`;
               } catch (abortErr) {
                  Logger.error('Failed to abort cherry-pick.', 'parallel');
                  Logger.debug(yuString(abortErr, { color: true }), 'parallel');
                  return 1;
               }

               if (stashRef) {
                  await restoreJoinStash(git$, forkPath, forkAlias, stashRef);
               }
               Logger.error(`Cherry-pick aborted while applying commit ${commit}.`, 'parallel');
               return 1;
            }
         }
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
         Logger.warn(
            `Failed to remove fork '${forkAlias}' after joining. Please remove it manually later.`
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
            fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
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

      const result = await joinWorktree(git$, forkPath, forkAlias, { keep, bringAll: false });
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
   const validFlags = ['--keep', '--all', '-r', '--recursive'];
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
   const recursive = flags.has('-r') || flags.has('--recursive');

   if (recursive && bringAll) {
      Logger.error('Recursive join does not support --all. Join forks individually.', 'parallel');
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
            'Usage: git parallel join [<alias>] [--keep|--all] | git parallel join -r [--keep]',
            'parallel'
         );
         return 1;
      }

      forkPath = ctx.repoRoot;
      forkAlias = ctx.alias!;
   }

   return await joinWorktree(git$, forkPath, forkAlias, { keep, bringAll });
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
${bright + _2PointGradient('PARALLEL', COLOR.Zinc400, COLOR.Zinc100, 0.2) + reset}
Manage parallel (forked) worktrees for iterative development.

${bright + _2PointGradient('OVERVIEW', COLOR.Zinc400, COLOR.Zinc100, 0.2) + reset}
\`${cyan}${EXECUTABLE_NAME} parallel${reset}\` helps you create and manage temporary forked worktrees for the current branch. Forked worktrees live under a temp worktree root and contain a small metadata file (.git-parallel.json) so the tool can later join, list or remove them cleanly.

Additionally, \`${cyan}${EXECUTABLE_NAME} parallel fork${reset}\` can auto-initialize submodules and
install dependencies using detected package managers (currently supports npm, pnpm, bun, and uv)
if configured (see \`${cyan}parallel.init${reset}\` config for options),
getting the fork ready for work in no time.

${bright + _2PointGradient('SUBCOMMANDS AND BEHAVIOR', COLOR.Zinc400, COLOR.Zinc100, 0.2) + reset}
- ${cyan}fork <alias>${reset}: Creates a detached worktree in a safe temporary namespace. If pending changes exist and you run with \`${cyan}--move${reset}\` or \`${cyan}--mirror${reset}\`, changes will be moved/applied to the fork. Init behaviors are controlled by config and \`${cyan}--no-init${reset}\`.
- ${cyan}join [<alias>] [--keep|--all]${reset}: Cherry-picks commits from the fork back into the origin worktree. \`${cyan}--keep${reset}\` retains the fork and updates its base; \`${cyan}--all${reset}\` also includes uncommitted changes.
- ${cyan}join -r|--recursive [--keep]${reset}: Joins every fork for the current branch back into origin. Recursive join does not allow \`${cyan}--all${reset}\`.
- ${cyan}list${reset}: Lists forks for the current branch with status, base commit, divergence and recent commits. Use ${cyan}--short${reset} for compact output.
- ${cyan}remove <alias>${reset}: Removes the forked worktree and cleans up the directory.

${bright + _2PointGradient('SAFETY AND NOTES', COLOR.Zinc400, COLOR.Zinc100, 0.2) + reset}
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
${cyan}${EXECUTABLE_NAME} parallel fork ${dim}<alias> [--move|--mirror] [--no-init[=submodule,pkg]]${reset}
${cyan}${EXECUTABLE_NAME} parallel list${reset}
${cyan}${EXECUTABLE_NAME} parallel open ${dim}<alias|origin> [-c|--copy]${reset}
${cyan}${EXECUTABLE_NAME} parallel switch ${dim}<alias|origin> [-c|--copy]${reset}
${cyan}${EXECUTABLE_NAME} parallel join ${dim}<alias> [--keep|--all]${reset}
${cyan}${EXECUTABLE_NAME} parallel join ${dim}-r|--recursive [--keep]${reset}
${cyan}${EXECUTABLE_NAME} parallel remove ${dim}<alias>${reset}

Examples:
   ${cyan}${EXECUTABLE_NAME} parallel fork feature-x --move ${reset + dim}# Create fork and optionally move changes${reset}
   ${cyan}${EXECUTABLE_NAME} parallel fork feature-x --no-init ${reset + dim}# Skip all init behaviors${reset}
   ${cyan}${EXECUTABLE_NAME} parallel fork feature-x --no-init=pkg ${reset + dim}# Skip package installs only${reset}
   ${cyan}${EXECUTABLE_NAME} parallel list --short ${reset + dim}# Compact output with recent commits${reset}
   ${cyan}${EXECUTABLE_NAME} parallel join feature-x --all ${reset + dim}# Merge fork back into origin${reset}
   ${cyan}${EXECUTABLE_NAME} parallel join -r ${reset + dim}# Merge all forks back into origin${reset}`,
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
      fork: ['--move', '--mirror', '--no-init'],
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
