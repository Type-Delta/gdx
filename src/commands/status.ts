import path from 'path';

import { CheckCache, Err, ncc, strWrap } from '@lib/Tools';

import { CommandHelpObj, CommandStructure, GdxContext } from '@/common/types';
import { $, $inherit } from '@/modules/shell';
import { quickPrint } from '@/utils/utilities';
import { COLOR, EXECUTABLE_NAME } from '@/consts';
import { _2PointGradient } from '@/modules/graphics';
import Logger from '@/utils/logger';
import global from '@/global';
import { getRepoRootCached } from '@/modules/git';

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
      const result = await $`${git$} -C ${submodulePath} ${buildSubmoduleStatusArgs(args)}`;
      return result.stdout;
   } catch (error) {
      const err = Err.from(error);
      Logger.warn(
         `Failed to get status for submodule ${submodulePath}.\nError: ${err.message}`,
         'status'
      );
      Logger.debug(
         `Failed to get status for submodule ${submodulePath}. \n${err.toString({ color: true })}`,
         'status'
      );
      return '';
   }
}

function buildSubmoduleStatusArgs(args: string[]): string[] {
   const baseArgs = ['status', ...args];
   if (CheckCache.supportsColor <= 0) return baseArgs;
   if (hasNoColorFlag(args) || hasPorcelainFlag(args) || hasExplicitColorFlag(args))
      return baseArgs;
   return ['-c', 'color.ui=always', ...baseArgs];
}

function hasNoColorFlag(args: string[]): boolean {
   return args.some((arg) => arg === '--no-color' || arg === '--color=never');
}

function hasPorcelainFlag(args: string[]): boolean {
   return args.some((arg) => arg === '--porcelain' || arg.startsWith('--porcelain='));
}

function hasExplicitColorFlag(args: string[]): boolean {
   return args.some((arg) => arg === '--color' || arg.startsWith('--color='));
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
   long: () => {
      const bright = ncc('Bright');
      const cyan = ncc('Cyan');
      const reset = ncc();
      return strWrap(
         `
${bright + _2PointGradient('STATUS', COLOR.Zinc400, COLOR.Zinc100, 0.2) + reset}
Show the working tree status for the repository and optionally all submodules.

${bright + _2PointGradient('OVERVIEW', COLOR.Zinc400, COLOR.Zinc100, 0.2) + reset}
\`${cyan}${EXECUTABLE_NAME} status${reset}\` is a wrapper around \`${cyan}git status${reset}\` with added support for recursive submodule status checking. When the \`${cyan}--recursive${reset}\` or \`${cyan}-r${reset}\` flag is used, it will show the status of the main repository followed by the status of each submodule.

${bright + _2PointGradient('RECURSIVE MODE', COLOR.Zinc400, COLOR.Zinc100, 0.2) + reset}
When \`${cyan}--recursive${reset}\` or \`${cyan}-r${reset}\` is specified:
- Shows status of the main repository first
- Then shows status for each submodule with clear headers
- Displays both absolute submodule paths and paths relative to your current directory
- All other \`${cyan}git status${reset}\` flags are passed through to each status check

${bright + _2PointGradient('EXAMPLES', COLOR.Zinc400, COLOR.Zinc100, 0.2) + reset}
${cyan}${EXECUTABLE_NAME} status --recursive${reset}
   Show status for repository and all submodules

${cyan}${EXECUTABLE_NAME} s -r${reset}
   Same as above using shorthand

${cyan}${EXECUTABLE_NAME} status -r --short${reset}
   Show short format status recursively

${cyan}${EXECUTABLE_NAME} status --recursive --porcelain${reset}
   Show porcelain format status recursively
`,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            mode: 'softboundary',
            indent: '  ',
         }
      );
   },
   short: 'Show working tree status with optional recursive submodule support',
   usage: () => {
      const cyan = ncc('Cyan');
      const dim = ncc('Dim');
      const reset = ncc();
      return strWrap(
         `
${cyan}${EXECUTABLE_NAME} status ${dim}[--recursive|-r] [<git-status-options>]${reset}
${cyan}${EXECUTABLE_NAME} s ${dim}[--recursive|-r] [<git-status-options>]${reset}

Examples:
   ${cyan}${EXECUTABLE_NAME} status --recursive ${reset + dim}# Show status for repo and all submodules${reset}
   ${cyan}${EXECUTABLE_NAME} s -r --short ${reset + dim}# Short format with submodules${reset}`,
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
      $allOf: ['-r', '--recursive', '--short', '--porcelain', '--branch', '--long'],
   },
} as const satisfies CommandStructure;
