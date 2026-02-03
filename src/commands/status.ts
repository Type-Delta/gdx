import path from 'path';

import { Err, ncc, strWrap } from '@lib/Tools';

import { CommandHelpObj, CommandStructure, GdxContext } from '@/common/types';
import { $, $inherit } from '@/modules/shell';
import { quickPrint } from '@/utils/utilities';
import { COLOR, EXECUTABLE_NAME } from '@/consts';
import { _2PointGradient } from '@/modules/graphics';
import Logger from '@/utils/logger';
import global from '@/global';
import { getRepoRootCached } from '@/modules/cache-controller';

/**
 * Represents a git submodule with its path information
 */
interface Submodule {
   path: string;
   status: string;
}

/**
 * Gets all submodules recursively from the repository
 */
async function getSubmodules(git$: string | string[]): Promise<Submodule[]> {
   try {
      // First, try to get submodule list from .gitmodules using config command
      const result = await $`${git$} config --file .gitmodules --get-regexp path`;
      const output = result.stdout.trim();

      if (!output) {
         return [];
      }

      const lines = output.split('\n');
      const submodules: Submodule[] = [];

      for (const line of lines) {
         if (!line.trim()) continue;

         // Format: submodule.<name>.path <path>
         const match = line.match(/^submodule\.(.+?)\.path\s+(.+)$/);
         if (match) {
            const submodulePath = match[2];
            submodules.push({
               path: submodulePath,
               status: ' ',
            });
         }
      }

      return submodules;
   } catch {
      // If .gitmodules doesn't exist or has no submodules, return empty array
      return [];
   }
}

/**
 * Runs git status for a specific submodule
 */
async function getSubmoduleStatus(
   git$: string | string[],
   submodulePath: string,
   args: string[]
): Promise<string> {
   try {
      const result = await $`${git$} -C ${submodulePath} status ${args}`;
      return result.stdout;
   } catch (error) {
      const err = Err.from(error);
      Logger.warn(`Failed to get status for submodule ${submodulePath}.\nError: ${err.message}`, 'status');
      Logger.debug(`Failed to get status for submodule ${submodulePath}. \n${err.toString({ color: true })}`, 'status');
      return '';
   }
}

/**
 * Main status command with recursive submodule support
 */
export default async function status(ctx: GdxContext): Promise<number> {
   const { git$, args } = ctx;

   // Check if recursive flag is present
   const hasRecursive = args.includes('-r') || args.includes('--recursive');

   if (!hasRecursive) {
      // No recursive flag, just pass through to git status
      return await $inherit`${git$} status ${args.slice(1)}`.then((r) => r.exitCode ?? 0);
   }

   // Remove recursive flags from args for passing to git status
   const statusArgs = args.slice(1).filter((arg) => arg !== '-r' && arg !== '--recursive');

   try {
      const repoRoot = await getRepoRootCached(git$);
      const currentDir = process.cwd();

      // Show main repository status first
      quickPrint(
         `${ncc('Cyan')}${ncc('Bright')}━━━ Repository Root${ncc()}${ncc('Dim')} (${path.relative(currentDir, repoRoot) || '.'})${ncc()}\n`
      );

      await $inherit`${git$} status ${statusArgs}`;

      // Get all submodules
      const submodules = await getSubmodules(git$);

      if (submodules.length === 0) {
         quickPrint(`\n${ncc('Dim')}No submodules found.${ncc()}`);
         return 0;
      }

      // Show status for each submodule
      for (const submodule of submodules) {
         const absolutePath = path.resolve(repoRoot, submodule.path);
         const relativePath = path.relative(currentDir, absolutePath);

         // Print submodule header
         quickPrint(
            `\n${ncc('Cyan')}${ncc('Bright')}━━━ Submodule: ${submodule.path}${ncc()}${ncc('Dim')} (${relativePath})${ncc()}\n`
         );

         // Get status for this submodule
         const submoduleStatus = await getSubmoduleStatus(git$, absolutePath, statusArgs);

         if (submoduleStatus) {
            quickPrint(submoduleStatus);
         } else {
            quickPrint(`${ncc('Dim')}Unable to get status for this submodule.${ncc()}\n`);
         }
      }

      return 0;
   } catch (err) {
      Logger.error(`Failed to get recursive status.\n${err}`, 'status');
      return 1;
   }
}

export const help = {
   long: () =>
      strWrap(
         `
${ncc('Bright') + _2PointGradient('STATUS', COLOR.Zinc400, COLOR.Zinc100, 0.2)}
Show the working tree status for the repository and optionally all submodules.

${ncc('Bright') + _2PointGradient('OVERVIEW', COLOR.Zinc400, COLOR.Zinc100, 0.2)}
\`${EXECUTABLE_NAME} status\` is a wrapper around \`git status\` with added support for recursive submodule status checking. When the \`--recursive\` or \`-r\` flag is used, it will show the status of the main repository followed by the status of each submodule.

${ncc('Bright') + _2PointGradient('RECURSIVE MODE', COLOR.Zinc400, COLOR.Zinc100, 0.2)}
When \`--recursive\` or \`-r\` is specified:
- Shows status of the main repository first
- Then shows status for each submodule with clear headers
- Displays both absolute submodule paths and paths relative to your current directory
- All other \`git status\` flags are passed through to each status check

${ncc('Bright') + _2PointGradient('EXAMPLES', COLOR.Zinc400, COLOR.Zinc100, 0.2)}
${ncc('Cyan')}${EXECUTABLE_NAME} status --recursive${ncc()}
   Show status for repository and all submodules

${ncc('Cyan')}${EXECUTABLE_NAME} s -r${ncc()}
   Same as above using shorthand

${ncc('Cyan')}${EXECUTABLE_NAME} status -r --short${ncc()}
   Show short format status recursively

${ncc('Cyan')}${EXECUTABLE_NAME} status --recursive --porcelain${ncc()}
   Show porcelain format status recursively
`,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            mode: 'softboundary',
            indent: '  ',
         }
      ),
   short: 'Show working tree status with optional recursive submodule support',
   usage: () =>
      strWrap(
         `
${ncc('Cyan')}${EXECUTABLE_NAME} status ${ncc('Dim')}[--recursive|-r] [<git-status-options>]${ncc()}
${ncc('Cyan')}${EXECUTABLE_NAME} s ${ncc('Dim')}[--recursive|-r] [<git-status-options>]${ncc()}

Examples:
   ${ncc('Cyan')}${EXECUTABLE_NAME} status --recursive ${ncc() + ncc('Dim')}# Show status for repo and all submodules${ncc()}
   ${ncc('Cyan')}${EXECUTABLE_NAME} s -r --short ${ncc() + ncc('Dim')}# Short format with submodules${ncc()}`,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            mode: 'softboundary',
            indent: '  ',
         }
      ),
} as const satisfies CommandHelpObj;

export const structure = {
   $root: {
      $allOf: ['-r', '--recursive', '--short', '--porcelain', '--branch', '--long'],
   },
} as const satisfies CommandStructure;
