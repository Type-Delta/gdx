import { GdxContext } from '../common/types';
import { createAbortableExec } from '../utils/shell';
import { quickPrint } from '../utils/utilities';
import { maxFraction, ncc, toShortNum } from '../../lib/esm/Tools';
import graph from './graph';
import { argsSet } from '../utils/arguments';
import { STATS_EST } from '../consts';

export default async function stats(ctx: GdxContext): Promise<number> {
   const exec = createAbortableExec();
   const $ = exec.$;

   const { args, git$ } = ctx;
   let email = '';
   let username = 'Your';

   // Check for --author
   const authorArgIndex = args.indexOf('--author');
   try {
      if (authorArgIndex !== -1 && authorArgIndex + 1 < args.length) {
         email = args[authorArgIndex + 1].trim();
         username = email.split('@')[0] + "'s";
      } else {
         const { stdout } = await $`${git$} config user.email`;
         email = stdout.trim();
      }
   }
   catch (err) {
      exec.abort();
      quickPrint(ncc('Red') + 'Error: Failed to read git config user.email.' + ncc());
      console.error(err);
      return 1;
   }

   if (!email) {
      console.error(ncc('Red') + 'Error: No user.email configured in git.' + ncc());
      return 1;
   }

   quickPrint(ncc('Cyan') + `Gathering stats for user: ` + ncc('Yellow') + email + ncc('Cyan') + ` this may take a while...` + ncc());

   try {
      // Parallel execution group 1
      const [
         repoRootRes,
         userTotalCmiRes,
         projectTotalCmiRes,
         todayCommitsRes,
         logStatsRes,
         projectLineStatsRes,
         branchesRes,
         lastCommitTimeRes
      ] = await Promise.all([
         $`${git$} rev-parse --show-toplevel`,
         $`${git$} rev-list --all --count --author=${email}`,
         $`${git$} rev-list --all --count`,
         $`${git$} log --all --author=${email} --since=midnight --pretty=tformat:%h`,
         $`${git$} log --all --author=${email} --pretty=tformat: --numstat`,
         $`${git$} log --all --pretty=tformat: --numstat`,
         $`${git$} for-each-ref --format=%(refname:short) refs/heads/`,
         $`${git$} log --all --author=${email} -1 --format=${"%ar [at %h] (on %ad)"}`
      ]);

      const projectName = repoRootRes.stdout.trim().split(/[\\/]/).pop();
      const userTotalCmi = userTotalCmiRes.stdout.trim();
      const projectTotalCmi = projectTotalCmiRes.stdout.trim();
      const todayCommits = todayCommitsRes.stdout.trim() ? todayCommitsRes.stdout.trim().split('\n').length : 0;

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
      const addedSize = toShortNum(totalAdded * STATS_EST.AVG_CHARS_PER_LINE, 2, 1024) + 'B';
      const removedSize = toShortNum(totalRemoved * STATS_EST.AVG_CHARS_PER_LINE, 2, 1024) + 'B';

      const addedFuncs = toShortNum(totalAdded / STATS_EST.AVG_LINES_PER_FUNCTION, 1, 1e3, false, 0);
      const removedFuncs = toShortNum(totalRemoved / STATS_EST.AVG_LINES_PER_FUNCTION, 1, 1e3, false, 0);
      const addedFiles = toShortNum(totalAdded / STATS_EST.AVG_LINES_PER_FILE, 1, 1e3, false, 0);
      const removedFiles = toShortNum(totalRemoved / STATS_EST.AVG_LINES_PER_FILE, 1, 1e3, false, 0);

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
      const contributionPct = projChanged > 0
         ? maxFraction(totalChanged / projChanged * 100, 2, true)
         : '0.00';

      // Most Active Branch
      const branches = branchesRes.stdout.split('\n').filter(b => b.trim());
      let maxCommits = 0;
      let topBranch = 'N/A';

      // Parallel execution for branches
      const branchCounts = await Promise.all(branches.map(async (branch) => {
         const { stdout } = await $`${git$} rev-list --count --author=${email} ${branch}`;
         return { branch, count: parseInt(stdout.trim(), 10) };
      }));

      for (const { branch, count } of branchCounts) {
         if (count > maxCommits) {
            maxCommits = count;
            topBranch = branch;
         }
      }

      // Last Commit
      const lastCommitTime = lastCommitTimeRes.stdout.trim() || 'Never';

      quickPrint(`\n=== ${username} Git Stats ===`);
      quickPrint(`Project:             ${ncc('Cyan')}${projectName}${ncc()}`);
      quickPrint(`Total Commits:       ${ncc('Green')}${userTotalCmi}${ncc()} (today: ${todayCommits}) / ${ncc('Yellow')}${projectTotalCmi}${ncc()} (all)`);
      quickPrint(`Total Lines Added:   ${ncc('Green')}+ ${totalAdded} lines ${ncc()}${ncc('Dim')}(roughly ${addedSize}, ${addedFuncs} functions or ${addedFiles} source files)${ncc()}`);
      quickPrint(`Total Lines Removed: ${ncc('Red')}- ${totalRemoved} lines ${ncc()}${ncc('Dim')}(roughly ${removedSize}, ${removedFuncs} functions or ${removedFiles} source files)${ncc()}`);
      quickPrint(`Contributions:       ${ncc('Magenta')}${contributionPct}%${ncc()} of all lines changed in the project`);
      quickPrint(`Most Active Branch:  ${ncc('Cyan')}${topBranch}${ncc()} (${maxCommits} commits)`);
      quickPrint(`Last Commit:         ${ncc('Yellow')}${lastCommitTime}${ncc()}`);

      // Pass --quiet to graph to match the PS behavior
      await graph({ ...ctx, args: argsSet(['--quiet', '--author', email]) });
      return 0;
   }
   catch (err) {
      exec.abort();
      const message = err instanceof Error ? err.message : 'Unknown error';
      quickPrint(ncc('Red') + `Error: ${message}` + ncc());
      return 1;
   }

}
