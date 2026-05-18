import path from 'path';

import { CheckCache, Err, strWrap } from '@lib/Tools';

import { CommandHelpObj, CommandStructure, GdxContext } from '@/common/types';
import { $, $inherit } from '@/modules/shell';
import { quickPrint } from '@/utils/utilities';
import { GDX_VPALETTE, EXECUTABLE_NAME, SGR } from '@/consts';
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
         `${SGR.cyan}${SGR.bright}━━━ Repository Root${SGR.reset}${SGR.dim} (${path.relative(currentDir, repoRoot) || '.'})${SGR.reset}\n`
      );

      await $inherit`${git$} status ${statusArgs}`;

      // Get all submodules
      const submodules = await getSubmodules(git$);

      if (submodules.length === 0) {
         quickPrint(`\n${SGR.dim}No submodules found.${SGR.reset}`);
         return 0;
      }

      // Show status for each submodule
      for (const submodule of submodules) {
         const absolutePath = path.resolve(repoRoot, submodule.path);
         const relativePath = path.relative(currentDir, absolutePath);

         // Print submodule header
         quickPrint(
            `\n${SGR.cyan}${SGR.bright}━━━ Submodule: ${submodule.path}${SGR.reset}${SGR.dim} (${relativePath})${SGR.reset}\n`
         );

         // Get status for this submodule
         const submoduleStatus = await getSubmoduleStatus(git$, absolutePath, statusArgs);

         if (submoduleStatus === null) {
            quickPrint(`${SGR.dim}Unable to get status for this submodule.${SGR.reset}\n`);
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
      return strWrap(
         litedent`
         ${SGR.bright + _2PointGradient('STATUS', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         Show the working tree status for the repository and optionally all submodules.

         ${SGR.bright + _2PointGradient('OVERVIEW', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         \`${SGR.cyan}${EXECUTABLE_NAME} status${SGR.reset}\` is a wrapper around \`${SGR.cyan}git status${SGR.reset}\` with added support for recursive submodule status checking. When the \`${SGR.cyan}--recursive${SGR.reset}\` or \`${SGR.cyan}-r${SGR.reset}\` flag is used, it will show the status of the main repository followed by the status of each submodule.

         ${SGR.bright + _2PointGradient('RECURSIVE MODE', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         When \`${SGR.cyan}--recursive${SGR.reset}\` or \`${SGR.cyan}-r${SGR.reset}\` is specified:
         - Shows status of the main repository first
         - Then shows status for each submodule with clear headers
         - Displays both absolute submodule paths and paths relative to your current directory
         - All other \`${SGR.cyan}git status${SGR.reset}\` flags are passed through to each status check

         ${SGR.bright + _2PointGradient('EXAMPLES', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} status --recursive${SGR.reset}
            Show status for repository and all submodules

         ${SGR.cyan}${EXECUTABLE_NAME} s -r${SGR.reset}
            Same as above using shorthand

         ${SGR.cyan}${EXECUTABLE_NAME} status -r --short${SGR.reset}
            Show short format status recursively

         ${SGR.cyan}${EXECUTABLE_NAME} status --recursive --porcelain${SGR.reset}
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
      return strWrap(
         litedent`
         ${SGR.cyan}${EXECUTABLE_NAME} status ${SGR.dim}[--recursive|-r] [<git-status-options>]${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} s ${SGR.dim}[--recursive|-r] [<git-status-options>]${SGR.reset}

         Examples:
            ${SGR.cyan}${EXECUTABLE_NAME} status --recursive ${SGR.reset + SGR.dim}# Show status for repo and all submodules${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} s -r --short ${SGR.reset + SGR.dim}# Short format with submodules${SGR.reset}`,
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
