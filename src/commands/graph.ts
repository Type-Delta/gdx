import { $ } from '../modules/shell';
import { quickPrint } from '../utils/utilities';
import { MathKit, ncc, strWrap } from '@lib/Tools';
import { CommandHelpObj, CommandStructure, GdxContext } from '../common/types';
import { _2PointGradientInterp, _2PointGradient, rgbVec2decimal } from '../modules/graphics';
import { GDX_VPALETTE, EXECUTABLE_NAME } from '../consts';
import Logger from '../utils/logger';
import global from '@/global';
import { getGitConfigCached } from '@/modules/git';
import litedent from '@/utils/litedent';

const LABEL_WIDTH = 6; // "Sun " + 2 spaces
const COL_WIDTH = 2; // "■ "
const RIGHT_MARGIN = 4;
const MIN_TERM_WIDTH = 12;

export default async function graph(ctx: GdxContext): Promise<number> {
   const { git$, args } = ctx;
   const isAllScope = !!args.popOption('--all') || !!args.popOption('-a');

   let email = '';
   if (!isAllScope) {
      email = args.popValue('--email') || (await getGitConfigCached(git$, 'user.email'));
      email = email ? email.trim().replace(/^["']|["']$/g, '') : email;

      if (!email) {
         // LINK: uwnkd11 string literal in spec
         Logger.error(
            'User email not configured. Please set it using "git config user.email <email>" or provide it with --email option.',
            'graph'
         );
         return 1;
      }
   }

   if (!args.includes('--quiet')) {
      quickPrint(
         isAllScope
            ? ncc('Cyan') + 'Generating commit graph for all authors' + ncc()
            : ncc('Cyan') + `Generating commit graph for user: ` + ncc('Yellow') + email + ncc()
      );
   }

   const termWidth = global.terminalWidth;
   const graphWidth = termWidth - LABEL_WIDTH - RIGHT_MARGIN;
   const totalWeeks = Math.min(Math.floor(graphWidth / COL_WIDTH), 52); // limit to 1 year

   if (graphWidth < MIN_TERM_WIDTH) {
      Logger.error(
         `Terminal width too small for graph display. Minimum required width is ${MIN_TERM_WIDTH + LABEL_WIDTH + RIGHT_MARGIN} columns.`,
         'graph'
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
      isAllScope
         ? await $`
      ${git$} --no-pager log --all --since=${startDate.toISOString()} --date=short --format=%ad
   `
         : await $`
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
      _2PointGradient(
         'Contribution Graph',
         GDX_VPALETTE.OceanDeepBlue,
         GDX_VPALETTE.OceanGreen,
         0.12,
         0.83
      ) +
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
            color = ncc('Dim') + ncc(rgbVec2decimal(GDX_VPALETTE.MidnightBlack));
            cellChar = '▨'; // Different char for zero commits
         } else {
            const intensity = MathKit.clamp(commitCount / maxCommits, 0.15, 1);
            const interpColor = _2PointGradientInterp(
               GDX_VPALETTE.MidnightBlack,
               GDX_VPALETTE.OceanGreen,
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
   long: () => {
      const bright = ncc('Bright');
      const cyan = ncc('Cyan');
      const reset = ncc();
      return strWrap(
         litedent`
         ${bright + _2PointGradient('GRAPH', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
         Render a calendar-style contribution graph for a repository author or the whole repository.

         ${bright + _2PointGradient('DESCRIPTION', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
         Visualize commit activity as a calendar-like heatmap showing commit density by day for the last N weeks (limited by terminal width). Each cell is colored to indicate relative commit frequency and can be clamped to a maximum of 52 weeks.

         ${bright + _2PointGradient('OPTIONS', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
         Supply ${cyan}--email <email>${reset} to override the configured git user email. Use ${cyan}--all${reset} or ${cyan}-a${reset} for project-wide commit graph across all authors. Use ${cyan}--quiet${reset} to suppress informational headers when embedding the graph in other scripts.

         ${bright + _2PointGradient('TERMINAL NOTES', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
         The graph respects \`${cyan}global.terminalWidth${reset}\`. If the terminal is too narrow the command will bail with an error message.
         `,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            mode: 'softboundary',
            indent: '  ',
         }
      );
   },
   short: 'Render a calendar-style contribution graph for an author or all authors.',
   usage: () => {
      const cyan = ncc('Cyan');
      const dim = ncc('Dim');
      const reset = ncc();
      return strWrap(
         litedent`
         ${cyan}${EXECUTABLE_NAME} graph ${dim}[--email <email>] [--all|-a] [--quiet]${reset}

         Examples:
            ${cyan}${EXECUTABLE_NAME} graph ${reset + dim}# Graph for configured git user${reset}
            ${cyan}${EXECUTABLE_NAME} graph --email bob@example.com ${reset + dim}# Graph for specified author${reset}
            ${cyan}${EXECUTABLE_NAME} graph --all ${reset + dim}# Graph for all authors${reset}`,
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
   $root: ['--email', '--all', '-a', '--quiet'],
} as const satisfies CommandStructure;
