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

export default async function stats(ctx: GdxContext): Promise<number> {
   const exec = createAbortableExec();
   const $ = exec.$;

   const { args, git$ } = ctx;

   if (!(await assertInGitWorktree(git$))) return 1;

   let email = '';
   let username = 'Your';

   // Check for --author
   const authorArgIndex = args.indexOf('--author');
   try {
      if (authorArgIndex !== -1 && authorArgIndex + 1 < args.length) {
         email = args[authorArgIndex + 1].trim();
         username = email.split('@')[0] + "'s";
      } else {
         email = await getGitConfigCached(git$, 'user.email');
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

   const spinnerCtrl = spinner({
      message: `Gathering stats for ${email}...`,
   });

   try {
      // Parallel execution group 1
      const [
         repoRootRes,
         userTotalCmiRes,
         projectTotalCmiRes,
         todayCommitsRes,
         logStatsRes,
         projectLineStatsRes,
         branches,
         lastCommitTimeRes,
      ] = await Promise.all([
         getRepoRootCached(git$),
         $`${git$} rev-list --all --count --author=${email}`,
         $`${git$} rev-list --all --count`,
         $`${git$} log --all --author=${email} --since=midnight --pretty=tformat:%h`,
         $`${git$} log --all --author=${email} --pretty=tformat: --numstat`,
         $`${git$} log --all --pretty=tformat: --numstat`,
         getGitBranchesCached(git$),
         $`${git$} log --all --author=${email} -1 --format=${`%ar ${ncc() + ncc('Dim')}[at %h] (on %ad)` + ncc()}`,
      ]);

      const projectName = repoRootRes.split(/[\\/]/).pop();
      const userTotalCmi = userTotalCmiRes.stdout.trim();
      const projectTotalCmi = projectTotalCmiRes.stdout.trim();
      const todayCommits = todayCommitsRes.stdout.trim()
         ? todayCommitsRes.stdout.trim().split('\n').length
         : 0;

      // Line stats
      const logStats = logStatsRes.stdout;
      let totalAdded = 0;
      let totalRemoved = 0;

      for (const line of logStats.split('\n')) {
         const match = line.match(/^(\d+)\s+(\d+)/);
         if (match) {
            totalAdded += parseInt(match[1], 10);
            totalRemoved += parseInt(match[2], 10);
         }
      }

      // Fun scales
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

      // Contribution %
      const projectLineStats = projectLineStatsRes.stdout;
      let projAdded = 0;
      let projRemoved = 0;
      for (const line of projectLineStats.split('\n')) {
         const match = line.match(/^(\d+)\s+(\d+)/);
         if (match) {
            projAdded += parseInt(match[1], 10);
            projRemoved += parseInt(match[2], 10);
         }
      }
      const totalChanged = totalAdded + totalRemoved;
      const projChanged = projAdded + projRemoved;
      const contributionPct =
         projChanged > 0 ? maxFraction((totalChanged / projChanged) * 100, 2, true) : '0.00';

      // Most Active Branch
      let maxCommits = 0;
      let topBranch = 'N/A';

      // Parallel execution for branches
      const branchCounts = await Promise.all(
         branches.map(async (branch) => {
            const { stdout } = await $`${git$} rev-list --count --author=${email} ${branch}`;
            return { branch, count: parseInt(stdout.trim(), 10) };
         })
      );

      for (const { branch, count } of branchCounts) {
         if (count > maxCommits) {
            maxCommits = count;
            topBranch = branch;
         }
      }

      // Last Commit
      const lastCommitTime = lastCommitTimeRes.stdout.trim() || 'Never';

      spinnerCtrl.stop();
      quickPrint(`  ${ncc('Dim') + ncc('Italic')}Showing stats for ${email} in ${projectName}${ncc()}

  ─── ${username} Git Stats ───
  Project:             ${ncc('Cyan')}${projectName}${ncc()}
  Total Commits:       ${ncc('Green')}${userTotalCmi}${ncc()} (today: ${todayCommits}) / ${ncc('Yellow')}${projectTotalCmi}${ncc()} (all)
  Total Lines Added:   ${ncc('Green')}+ ${totalAdded} lines ${ncc()}${ncc('Dim')}(roughly ${addedSize}, ${addedFuncs} functions or ${addedFiles} source files)${ncc()}
  Total Lines Removed: ${ncc('Red')}- ${totalRemoved} lines ${ncc()}${ncc('Dim')}(roughly ${removedSize}, ${removedFuncs} functions or ${removedFiles} source files)${ncc()}
  Contributions:       ${ncc('Magenta')}${contributionPct}%${ncc()} of all lines changed in the project
  Most Active Branch:  ${ncc('Cyan')}${topBranch}${ncc()} (${maxCommits} commits)
  Last Commit:         ${ncc('Yellow')}${lastCommitTime}${ncc()}
      `);

      // Pass --quiet to graph to match the PS behavior
      await graph({ ...ctx, args: argsSet(['--quiet', '--author', email]) });
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
Total commits by the author, today's commits, lines added/removed, rough size estimates (bytes), estimated functions/files added or removed, contribution percentage of the project, most active branch, and time of the last commit.

${bright + _2PointGradient('HOW IT WORKS', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
The command runs multiple git queries in parallel to collect commit lists, per-commit numstat, branch lists and last-commit metadata. For large repos this may take some time; progress messages are shown while queries run.

${bright + _2PointGradient('OPTIONS', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
Use ${cyan}--author <email>${reset} to target a different author than the configured git user.email. Output includes a small visual graph invocation via the \`${cyan}graph${reset}\` command by default.
`,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            mode: 'softboundary',
            indent: '  ',
         }
      );
   },
   short: 'Show (local) contribution statistics for a repository author.',
   usage: () => {
      const cyan = ncc('Cyan');
      const dim = ncc('Dim');
      const reset = ncc();
      return strWrap(
         `
${cyan}${EXECUTABLE_NAME} stats ${dim}[--author <email>]${reset}

Examples:
   ${cyan}${EXECUTABLE_NAME} stats ${reset + dim}# Stats for configured git user${reset}
   ${cyan}${EXECUTABLE_NAME} stats --author alice@example.com ${reset + dim}# Stats for specified author${reset}`,
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
   $root: ['--author'],
} as const satisfies CommandStructure;
