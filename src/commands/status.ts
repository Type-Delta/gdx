import path from 'path';

import { CheckCache, Err, ncc, strWrap } from '@lib/Tools';

import { CommandHelpObj, CommandStructure, GdxContext } from '@/common/types';
import { $, $inherit } from '@/modules/shell';
import { quickPrint } from '@/utils/utilities';
import { GDX_VPALETTE, EXECUTABLE_NAME } from '@/consts';
import { _2PointGradient } from '@/modules/graphics';
import Logger from '@/utils/logger';
import global from '@/global';
import { getGitConfigRegexp, getRepoRootCached } from '@/modules/git';
import litedent from '@/utils/litedent';

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
      const entries = await getGitConfigRegexp(git$, '^submodule\\..*\\.path$', {
         filePath: '.gitmodules',
      });
      if (entries.length === 0) {
         return [];
      }
      const submodules: Submodule[] = [];

      for (const entry of entries) {
         const submodulePath = entry.value.trim();
         if (!submodulePath) continue;
         submodules.push({
            path: submodulePath,
            status: ' ',
         });
      }

      return submodules;
   } catch {
      // If .gitmodules doesn't exist or has no submodules, return empty array
      return [];
   }
}

/**
 * Runs git status for a specific submodule.
 * @param git$ - Git executable path or command array.
 * @param submodulePath - Absolute path to the submodule.
 * @param args - Arguments to pass to git status.
 * @returns The stdout output, or null when the command fails.
 */
async function getSubmoduleStatus(
   git$: string | string[],
   submodulePath: string,
   args: string[]
): Promise<string | null> {
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
      return null;
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

   const statusArgs = args.slice(1);
   let hasRecursive = false;

   while (statusArgs.popOption('-r')) {
      hasRecursive = true;
   }

   while (statusArgs.popOption('--recursive')) {
      hasRecursive = true;
   }

   if (!hasRecursive) {
      // No recursive flag, just pass through to git status
      return await $inherit`${git$} status ${statusArgs}`.then((r) => r.exitCode ?? 0);
   }

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

         if (submoduleStatus === null) {
            quickPrint(`${ncc('Dim')}Unable to get status for this submodule.${ncc()}\n`);
            continue;
         }

         if (submoduleStatus) {
            quickPrint(submoduleStatus);
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
         litedent`
         ${bright + _2PointGradient('STATUS', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
         Show the working tree status for the repository and optionally all submodules.

         ${bright + _2PointGradient('OVERVIEW', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
         \`${cyan}${EXECUTABLE_NAME} status${reset}\` is a wrapper around \`${cyan}git status${reset}\` with added support for recursive submodule status checking. When the \`${cyan}--recursive${reset}\` or \`${cyan}-r${reset}\` flag is used, it will show the status of the main repository followed by the status of each submodule.

         ${bright + _2PointGradient('RECURSIVE MODE', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
         When \`${cyan}--recursive${reset}\` or \`${cyan}-r${reset}\` is specified:
         - Shows status of the main repository first
         - Then shows status for each submodule with clear headers
         - Displays both absolute submodule paths and paths relative to your current directory
         - All other \`${cyan}git status${reset}\` flags are passed through to each status check

         ${bright + _2PointGradient('EXAMPLES', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
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
         litedent`
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
