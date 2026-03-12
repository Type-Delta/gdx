import { maxFraction, ncc, toShortNum, yuString, strWrap } from '@lib/Tools';

import { CommandHelpObj, CommandStructure, GdxContext } from '../common/types';
import { createAbortableExec, spinner } from '../modules/shell';
import { quickPrint } from '../utils/utilities';
import graph from './graph';
import { argsSet } from '../modules/arguments';
import { EXECUTABLE_NAME, STATS_EST, GDX_VPALETTE } from '../consts';
import global from '@/global';
import { _2PointGradient } from '../modules/graphics';
import Logger from '../utils/logger';
import {
   getRepoRootCached,
   getGitConfigCached,
   getGitBranchesCached,
   assertInGitWorktree,
} from '@/modules/git';
import {
   DEFAULT_LANGUAGE_COLOR,
   getLanguageCatalog,
   inferLanguageFromPath,
   type LanguageCatalog,
} from '@/modules/languages';

const LANGUAGE_BAR_PREFIX = '  Language Usage:      ';

interface ParsedNumStat {
   totalAdded: number;
   totalRemoved: number;
   changedFiles: Array<{ filePath: string; changedLines: number }>;
}

interface LanguageUsageBar {
   bar: string;
   legend: string;
}

export default async function stats(ctx: GdxContext): Promise<number> {
   const exec = createAbortableExec();
   const $ = exec.$;

   const { args, git$ } = ctx;

   if (!(await assertInGitWorktree(git$))) return 1;

   const isAllScope = args.hasOption('--all') || args.hasOption('-a');
   args.popOption('--all');
   args.popOption('-a');

   let email = '';
   let username = 'Your';
   let scopeLabel = '';

   if (!isAllScope) {
      try {
         const emailArg = args.popValue('--author');
         if (emailArg) {
            email = emailArg.trim().replace(/^["']|["']$/g, '');
            username = email.split('@')[0] + "'s";
         } else {
            email = await getGitConfigCached(git$, 'user.email');
            email = email ? email.trim().replace(/^["']|["']$/g, '') : email;
         }
      } catch (err) {
         exec.abort();
         Logger.error('Failed to read git config user.email.', 'stats');
         Logger.error(yuString(err, { color: true }), 'stats');
         return 1;
      }

      if (!email) {
         Logger.error('No user.email configured in git.', 'stats');
         return 1;
      }

      scopeLabel = email;
   } else {
      username = 'Project-wide';
      scopeLabel = 'all authors';
   }

   const spinnerCtrl = spinner({
      message: isAllScope ? 'Gathering project-wide stats...' : `Gathering stats for ${email}...`,
   });

   try {
      const projectTotalCmiPromise = $`${git$} rev-list --all --count`;
      const projectLineStatsPromise = $`${git$} log --all --pretty=tformat: --numstat`;

      const [
         repoRootRes,
         scopedTotalCmiRes,
         projectTotalCmiRes,
         todayCommitsRes,
         scopedLogStatsRes,
         projectLineStatsRes,
         branches,
         lastCommitTimeRes,
      ] = await Promise.all([
         getRepoRootCached(git$),
         isAllScope ? projectTotalCmiPromise : $`${git$} rev-list --all --count --author=${email}`,
         projectTotalCmiPromise,
         isAllScope
            ? $`${git$} log --all --since=midnight --pretty=tformat:%h`
            : $`${git$} log --all --author=${email} --since=midnight --pretty=tformat:%h`,
         isAllScope
            ? projectLineStatsPromise
            : $`${git$} log --all --author=${email} --pretty=tformat: --numstat`,
         projectLineStatsPromise,
         getGitBranchesCached(git$),
         isAllScope
            ? $`${git$} log --all -1 --format=${`%ar ${ncc() + ncc('Dim')}[at %h] (on %ad)` + ncc()}`
            : $`${git$} log --all --author=${email} -1 --format=${`%ar ${ncc() + ncc('Dim')}[at %h] (on %ad)` + ncc()}`,
      ]);

      let languageCatalog: LanguageCatalog | null = null;
      try {
         languageCatalog = await getLanguageCatalog({
            spinner: spinnerCtrl,
         });
      } catch {
         languageCatalog = null;
      }

      const projectName = repoRootRes.split(/[\\/]/).pop();
      const scopedTotalCmi = scopedTotalCmiRes.stdout.trim();
      const projectTotalCmi = projectTotalCmiRes.stdout.trim();
      const todayCommits = todayCommitsRes.stdout.trim()
         ? todayCommitsRes.stdout.trim().split('\n').length
         : 0;

      const scopedNumStat = parseNumStat(scopedLogStatsRes.stdout);
      const totalAdded = scopedNumStat.totalAdded;
      const totalRemoved = scopedNumStat.totalRemoved;

      const addedSize = toShortNum(totalAdded * STATS_EST.AVG_CHARS_PER_LINE, 2, 1024) + 'iB';
      const removedSize = toShortNum(totalRemoved * STATS_EST.AVG_CHARS_PER_LINE, 2, 1024) + 'iB';

      const addedFuncs = toShortNum(
         totalAdded / STATS_EST.AVG_LINES_PER_FUNCTION,
         1,
         1e3,
         false,
         0
      );
      const removedFuncs = toShortNum(
         totalRemoved / STATS_EST.AVG_LINES_PER_FUNCTION,
         1,
         1e3,
         false,
         0
      );
      const addedFiles = toShortNum(totalAdded / STATS_EST.AVG_LINES_PER_FILE, 1, 1e3, false, 0);
      const removedFiles = toShortNum(
         totalRemoved / STATS_EST.AVG_LINES_PER_FILE,
         1,
         1e3,
         false,
         0
      );

      const projectNumStat = parseNumStat(projectLineStatsRes.stdout);
      const projAdded = projectNumStat.totalAdded;
      const projRemoved = projectNumStat.totalRemoved;
      const totalChanged = totalAdded + totalRemoved;
      const projChanged = projAdded + projRemoved;
      const contributionPct =
         projChanged > 0 ? maxFraction((totalChanged / projChanged) * 100, 2, true) : '0.00';

      let maxCommits = 0;
      let topBranch = 'N/A';

      const branchCounts = await Promise.all(
         branches.map(async (branch) => {
            const { stdout } = isAllScope
               ? await $`${git$} rev-list --count refs/heads/${branch}`
               : await $`${git$} rev-list --count --author=${email} refs/heads/${branch}`;
            return { branch, count: parseInt(stdout.trim(), 10) };
         })
      );

      for (const { branch, count } of branchCounts) {
         if (count > maxCommits) {
            maxCommits = count;
            topBranch = branch;
         }
      }

      const lastCommitTime = lastCommitTimeRes.stdout.trim() || 'Never';

      spinnerCtrl.stop();
      quickPrint(`  ${ncc('Dim') + ncc('Italic')}Showing stats for ${scopeLabel} in ${projectName}${ncc()}

  ─── ${username} Git Stats ───
  Project:             ${ncc('Cyan')}${projectName}${ncc()}
  Total Commits:       ${ncc('Green')}${scopedTotalCmi}${ncc()} (today: ${todayCommits}) / ${ncc('Yellow')}${projectTotalCmi}${ncc()} (all)
  Total Lines Added:   ${ncc('Green')}+ ${totalAdded} lines ${ncc()}${ncc('Dim')}(roughly ${addedSize}, ${addedFuncs} functions or ${addedFiles} source files)${ncc()}
  Total Lines Removed: ${ncc('Red')}- ${totalRemoved} lines ${ncc()}${ncc('Dim')}(roughly ${removedSize}, ${removedFuncs} functions or ${removedFiles} source files)${ncc()}
  Contributions:       ${ncc('Magenta')}${contributionPct}%${ncc()} of all lines changed in the project
  Most Active Branch:  ${ncc('Cyan')}${topBranch}${ncc()} (${maxCommits} commits)
  Last Commit:         ${ncc('Yellow')}${lastCommitTime}${ncc()}`
      );

      if (languageCatalog) {
         const languageBarWidth = Math.max(
            24,
            Math.min(56, global.terminalWidth - LANGUAGE_BAR_PREFIX.length - 2)
         );
         const usageBar = renderLanguageUsageBar(
            languageCatalog,
            scopedNumStat.changedFiles,
            totalChanged,
            languageBarWidth
         );

         if (usageBar) {
            const usageLegendPrefix = ' '.repeat(LANGUAGE_BAR_PREFIX.length);
            quickPrint(
               `${LANGUAGE_BAR_PREFIX}${usageBar.bar}\n${usageLegendPrefix}${usageBar.legend}\n`
            );
         }
      }

      await graph({
         ...ctx,
         args: isAllScope ? argsSet(['--quiet', '--all']) : argsSet(['--quiet', '--email', email]),
      });
      return 0;
   } catch (err) {
      spinnerCtrl.stop();
      exec.abort();
      Logger.error(yuString(err, { color: true }));
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
${bright + _2PointGradient('STATS', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
Gather detailed contribution statistics for a git author in this repository.

${bright + _2PointGradient('WHAT IT COMPUTES', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
Total commits by the selected scope, today's commits, lines added/removed, rough size estimates (bytes), estimated functions/files added or removed, contribution percentage of the project, most active branch, language usage by modified lines, and time of the last commit.

${bright + _2PointGradient('HOW IT WORKS', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
The command runs multiple git queries in parallel to collect commit lists, per-commit numstat, branch lists and last-commit metadata. For large repos this may take some time; progress messages are shown while queries run.

${bright + _2PointGradient('OPTIONS', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
Use ${cyan}--author <email>${reset} to target a different author than the configured git user.email. Use ${cyan}--all${reset} or ${cyan}-a${reset} for project-wide stats across all authors. Output includes a small visual graph invocation via the \`${cyan}graph${reset}\` command by default.
`,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            mode: 'softboundary',
            indent: '  ',
         }
      );
   },
   short: 'Show contribution statistics for an author or the whole project.',
   usage: () => {
      const cyan = ncc('Cyan');
      const dim = ncc('Dim');
      const reset = ncc();
      return strWrap(
         `
${cyan}${EXECUTABLE_NAME} stats ${dim}[--author <email>] [--all|-a]${reset}

Examples:
   ${cyan}${EXECUTABLE_NAME} stats ${reset + dim}# Stats for configured git user${reset}
   ${cyan}${EXECUTABLE_NAME} stats --author alice@example.com ${reset + dim}# Stats for specified author${reset}
   ${cyan}${EXECUTABLE_NAME} stats --all ${reset + dim}# Project-wide stats for all authors${reset}`,
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
   $root: ['--author', '--all', '-a'],
} as const satisfies CommandStructure;

/**
 * Parses git numstat output and accumulates changed lines per file.
 *
 * @param raw - Raw output from `git log --numstat`.
 * @returns Aggregated totals and file-level changes.
 */
function parseNumStat(raw: string): ParsedNumStat {
   let totalAdded = 0;
   let totalRemoved = 0;
   const changedFiles: Array<{ filePath: string; changedLines: number }> = [];

   for (const line of raw.split('\n')) {
      const parts = line.split('\t');
      if (parts.length < 3) continue;

      const [addedRaw, removedRaw] = parts;
      if (!/^\d+$/.test(addedRaw) || !/^\d+$/.test(removedRaw)) continue;

      const added = parseInt(addedRaw, 10);
      const removed = parseInt(removedRaw, 10);
      const changed = added + removed;
      if (changed <= 0) continue;

      totalAdded += added;
      totalRemoved += removed;
      changedFiles.push({
         filePath: normalizeNumStatPath(parts.slice(2).join('\t').trim()),
         changedLines: changed,
      });
   }

   return {
      totalAdded,
      totalRemoved,
      changedFiles,
   };
}

/**
 * Resolves a representative file path from numstat output.
 *
 * @param filePath - Raw numstat path segment.
 * @returns Normalized path used for extension-based language inference.
 */
function normalizeNumStatPath(filePath: string): string {
   const renameSeparator = filePath.lastIndexOf('=>');
   if (renameSeparator === -1) return filePath;

   let normalized = filePath.slice(renameSeparator + 2).trim();
   if (normalized.startsWith('{')) normalized = normalized.slice(1);
   if (normalized.endsWith('}')) normalized = normalized.slice(0, -1);
   return normalized.trim();
}

/**
 * Builds a colored language usage bar and legend text.
 *
 * @param catalog - Language catalog used for extension lookup.
 * @param changedFiles - Changed lines grouped by file path.
 * @param totalChanged - Total changed lines in selected scope.
 * @param barWidth - Target bar width in visible columns.
 * @returns Renderable bar and legend or null when no changes exist.
 */
function renderLanguageUsageBar(
   catalog: LanguageCatalog,
   changedFiles: Array<{ filePath: string; changedLines: number }>,
   totalChanged: number,
   barWidth: number
): LanguageUsageBar | null {
   if (totalChanged <= 0 || barWidth <= 0) return null;

   let othersLines = 0;
   const languageLines = new Map<string, { name: string; color: number; lines: number }>();

   for (const file of changedFiles) {
      const language = inferLanguageFromPath(catalog, file.filePath);
      if (!language) {
         othersLines += file.changedLines;
         continue;
      }

      const current = languageLines.get(language.name);
      if (current) {
         current.lines += file.changedLines;
      } else {
         languageLines.set(language.name, {
            name: language.name,
            color: language.color,
            lines: file.changedLines,
         });
      }
   }

   const visibleBuckets: {
      name: string;
      color: number;
      lines: number;
      cols: number;
      remainder: number;
      isOthers: boolean;
   }[] = [];

   for (const lang of languageLines.values()) {
      const rawCols = (lang.lines / totalChanged) * barWidth;
      if (rawCols < 1) {
         othersLines += lang.lines;
         continue;
      }

      const wholeCols = Math.floor(rawCols);
      visibleBuckets.push({
         name: lang.name,
         color: lang.color,
         lines: lang.lines,
         cols: wholeCols,
         remainder: rawCols - wholeCols,
         isOthers: false,
      });
   }

   if (othersLines > 0) {
      const rawCols = (othersLines / totalChanged) * barWidth;
      const wholeCols = Math.floor(rawCols);
      visibleBuckets.push({
         name: 'Others',
         color: DEFAULT_LANGUAGE_COLOR,
         lines: othersLines,
         cols: wholeCols,
         remainder: rawCols - wholeCols,
         isOthers: true,
      });
   }

   if (visibleBuckets.length === 0) return null;

   const othersBucket = visibleBuckets.find((bucket) => bucket.isOthers);
   if (othersBucket && othersBucket.cols === 0) {
      othersBucket.cols = 1;
      othersBucket.remainder = 0;
   }

   let usedCols = visibleBuckets.reduce((sum, bucket) => sum + bucket.cols, 0);
   if (usedCols > barWidth) {
      const shrinkable = visibleBuckets
         .filter((bucket) => !bucket.isOthers)
         .sort((a, b) => b.cols - a.cols);

      for (const bucket of shrinkable) {
         while (usedCols > barWidth && bucket.cols > 1) {
            bucket.cols -= 1;
            usedCols -= 1;
         }
         if (usedCols <= barWidth) break;
      }
   }

   if (usedCols > barWidth && othersBucket && othersBucket.cols > 1) {
      while (usedCols > barWidth && othersBucket.cols > 1) {
         othersBucket.cols -= 1;
         usedCols -= 1;
      }
   }

   let remaining = barWidth - usedCols;
   if (remaining > 0) {
      const byRemainder = [...visibleBuckets].sort((a, b) => b.remainder - a.remainder);
      let idx = 0;
      while (remaining > 0 && byRemainder.length > 0) {
         byRemainder[idx % byRemainder.length].cols += 1;
         remaining -= 1;
         idx += 1;
      }
   }

   const renderedBuckets = visibleBuckets
      .filter((bucket) => bucket.cols > 0)
      .sort((a, b) => b.lines - a.lines);
   const topBucket = renderedBuckets[0];
   const topBucketPct = maxFraction((topBucket.lines / totalChanged) * 100, 1, true);

   const bar =
      renderedBuckets
         .map((bucket) => `${ncc(bucket.color, 'fg')}${'━'.repeat(bucket.cols)}`)
         .join('') + ncc();

   const legend =
      `${ncc(topBucket.color, 'fg')}●${ncc()} ${topBucketPct}% ${topBucket.name} ` +
      ncc('Dim') + renderedBuckets.slice(1)
         .map((bucket) => `${ncc(bucket.color, 'fg')}●${ncc('White')} ${bucket.name}`)
         .join('  ');

   return { bar, legend };
}
