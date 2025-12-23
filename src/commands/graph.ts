import dedent from 'dedent';

import { $ } from '../utils/shell';
import { quickPrint } from '../utils/utilities';
import { ncc } from '@lib/Tools';
import { GdxContext } from '../common/types';
import { _2PointGradientInterp, _2PointGradient, rgbVec2decimal } from '../utils/graphics';
import { COLOR, EXECUTABLE_NAME } from '../consts';

const LABEL_WIDTH = 6; // "Sun " + 2 spaces
const COL_WIDTH = 2; // "■ "
const RIGHT_MARGIN = 4;
const MIN_TERM_WIDTH = 12;

export default async function graph(ctx: GdxContext): Promise<number> {
   const { git$, args } = ctx;
   let email = args.popValue('--email') || (await $`${git$} config user.email`).stdout;
   email = email ? email.trim().replace(/^["']|["']$/g, '') : email;

   if (!email) {
      // LINK: uwnkd11 string literal in spec
      quickPrint(
         ncc('Red') +
         'User email not configured. Please set it using "git config user.email <email>" or provide it with --email option.' +
         ncc()
      );
      return 1;
   }

   if (!args.includes('--quiet')) {
      quickPrint(
         ncc('Cyan') + `Generating commit graph for user: ` + ncc('Yellow') + email + ncc()
      );
   }

   const termWidth = process.stdout.columns || 80;
   const graphWidth = termWidth - LABEL_WIDTH - RIGHT_MARGIN;
   const totalWeeks = Math.min(Math.floor(graphWidth / COL_WIDTH), 52); // limit to 1 year

   if (graphWidth < MIN_TERM_WIDTH) {
      quickPrint(
         ncc('Red') +
         `Terminal width too small for graph display. Minimum required width is ${MIN_TERM_WIDTH + LABEL_WIDTH + RIGHT_MARGIN} columns.` +
         ncc()
      );
      return 1;
   }

   // Calculate start date (totalWeeks ago, aligned to week start)
   const today = new Date();
   const startDate = new Date(today);
   const dayOfWeek = startDate.getDay(); // 0 (Sun) to 6 (Sat)
   startDate.setDate(startDate.getDate() - dayOfWeek); // Move to last Sunday
   startDate.setDate(startDate.getDate() - totalWeeks * 7);

   // Fetch commit data
   const strLog = (
      await $`
      ${git$} --no-pager log --all --author=${email} --since=${startDate.toISOString()} --date=short --format=%ad
   `
   ).stdout.trim();

   const commitCounts: Record<string, number> = {};
   for (const line of strLog.split('\n')) {
      const date = line.trim();
      if (date) {
         commitCounts[date] = (commitCounts[date] || 0) + 1;
      }
   }

   // Find max commits in a single day for scaling
   let maxCommits = 1;
   for (const count of Object.values(commitCounts)) {
      if (count > maxCommits) {
         maxCommits = count;
      }
   }

   quickPrint(
      '\n  ' +
      ncc('Bright') +
      _2PointGradient('Contribution Graph', COLOR.OceanDeepBlue, COLOR.OceanGreen, 0.12, 0.83) +
      ` (Max: ${maxCommits} commits/day)\n`
   );

   // Draw header (month labels)
   let monthLabel = '      '; // Initial padding
   let nextFreeIndex = 0;
   let prevMonth = -1;

   for (let week = 0; week <= totalWeeks; week++) {
      const weekStartDate = new Date(startDate);
      weekStartDate.setDate(weekStartDate.getDate() + week * 7);
      const targetIndex = week * COL_WIDTH;

      // Only print if we are past the end of the previous label
      if (weekStartDate.getMonth() !== prevMonth && targetIndex >= nextFreeIndex) {
         // Pad with spaces until we reach the target index
         monthLabel += ' '.repeat(targetIndex - nextFreeIndex);

         const monthStr = weekStartDate.toLocaleString('default', { month: 'short' });
         monthLabel += monthStr.padEnd(COL_WIDTH * 3, ' ');
         nextFreeIndex = targetIndex + COL_WIDTH * 3;
         prevMonth = weekStartDate.getMonth();
      }
   }
   quickPrint(ncc('Bright') + monthLabel + ncc());

   // Draw graph rows (days of week)
   const dayLabels = ['   ', 'Mon', '   ', 'Wed', '   ', 'Fri', '   '];
   for (let day = 0; day < 7; day++) {
      let row = ncc('Bright') + dayLabels[day] + ncc() + ' ';

      for (let week = 0; week <= totalWeeks; week++) {
         const cellDate = new Date(startDate);
         cellDate.setDate(cellDate.getDate() + week * 7 + day);

         if (cellDate > today) {
            row += '  ';
            continue; // Future dates
         }

         const dateStr = cellDate.toISOString().slice(0, 10);
         const commitCount = commitCounts[dateStr] || 0;

         // Determine color based on commit count
         let color: string;
         let cellChar = '■';
         if (commitCount === 0) {
            color = ncc('Dim') + ncc(rgbVec2decimal(COLOR.MidnightBlack));
            cellChar = '▨'; // Different char for zero commits
         } else {
            const intensity = Math.min(commitCount / maxCommits, 1);
            const interpColor = _2PointGradientInterp(
               COLOR.MidnightBlack,
               COLOR.OceanGreen,
               intensity
            );
            color = ncc(rgbVec2decimal(interpColor));
         }

         row += color + cellChar + ncc() + ' ';
      }

      quickPrint('  ' + row);
   }

   quickPrint(''); // Final newline
   return 0;
}

export const help = {
   long: dedent(`${ncc('Cyan')}graph - Render a calendar-style contribution graph for a repository author${ncc()}

      ${ncc('Bright')}Purpose:${ncc()} Visualize commit activity as a calendar-like heatmap showing commit
      density by day for the last N weeks (limited by terminal width). Each cell is colored to indicate
      relative commit frequency and can be clamped to a maximum of 52 weeks.

      ${ncc('Bright')}Options:${ncc()} Supply \`--email <email>\` to override the configured git user email.
      Use \`--quiet\` to suppress informational headers when embedding the graph in other scripts.

      ${ncc('Bright')}Terminal notes:${ncc()} The graph respects \`process.stdout.columns\`. If the terminal is
      too narrow the command will bail with an error message. Colors are rendered via the \`ncc()\` helper.
   `),
   short: 'Render a calendar-style contribution graph for an author.',
   usage: dedent(`
      ${EXECUTABLE_NAME} graph [--email <email>] [--quiet]

      Examples:
        ${EXECUTABLE_NAME} graph                         # Graph for configured git user
        ${EXECUTABLE_NAME} graph --email bob@example.com  # Graph for specified author
   `),
};
