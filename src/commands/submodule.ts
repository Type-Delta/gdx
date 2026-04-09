import path from 'path';

import { ncc, strWrap } from '@lib/Tools';

import { CommandHelpObj, CommandStructure, GdxContext } from '@/common/types';
import { getConfig } from '@/common/config';
import { EXECUTABLE_NAME, GDX_RESULT_FILE, GDX_VPALETTE } from '@/consts';
import * as fs from '@/modules/fs';
import {
   AddSubmoduleOptions,
   DeinitSubmoduleOptions,
   UpdateSubmoduleOptions,
   addSubmodule,
   deinitSubmodules,
   getMainWorktreeRoot,
   getRepoRootCached,
   getSubmodules,
   updateSubmodules,
} from '@/modules/git';
import { _2PointGradient } from '@/modules/graphics';
import { scheduleChangeDir } from '@/modules/shell';
import Logger from '@/utils/logger';
import { asUnixPath } from '@/utils/path';
import { progressiveMatch } from '@/utils/utilities';
import { ArgsSet } from '@/modules/arguments';
import global from '@/global';
import litedent from '@/utils/litedent';

export async function switchSubmodule(ctx: GdxContext): Promise<number> {
   const args = ctx.args;
   const target = args[2];

   if (!GDX_RESULT_FILE) {
      Logger.error(
         `'git submodule switch' requires the shell integration. See readme for details.`
      );
      return 1;
   }

   if (!target) {
      Logger.error('Missing submodule path to switch into.', 'submodule');
      return 1;
   }

   const mainRoot = await getMainWorktreeRoot(ctx.git$);

   const normalizedTarget = asUnixPath(target)
      .replace(/^\.\/+/, '')
      .replace(/\/+$/, '');

   if (normalizedTarget === 'main') {
      await scheduleChangeDir(mainRoot);
      return 0;
   }

   const submodules = await getSubmodules(ctx.git$, mainRoot);
   if (submodules.length === 0) {
      Logger.error('No submodules found in this repository.', 'submodule');
      return 1;
   }
   const candidatePaths = submodules.map((submodule) =>
      asUnixPath(submodule.path).replace(/\/+$/, '')
   );

   let selected: string | null = null;
   if (normalizedTarget && !normalizedTarget.includes('/')) {
      const tailMatches = candidatePaths.filter((candidate) => {
         const parts = candidate.split('/');
         return parts[parts.length - 1] === normalizedTarget;
      });

      if (tailMatches.length === 1) {
         selected = tailMatches[0];
      } else if (tailMatches.length > 1) {
         Logger.error(
            `Ambiguous submodule '${target}'. Matches: ${tailMatches.join(', ')}.`,
            'submodule'
         );
         return 1;
      }
   }

   if (!selected) {
      const { match, candidates } = progressiveMatch(normalizedTarget, candidatePaths);
      if (match) {
         selected = match;
      } else if (candidates && candidates.length > 1) {
         Logger.error(
            `Ambiguous submodule '${target}'. Matches: ${candidates.join(', ')}.`,
            'submodule'
         );
         return 1;
      }
   }

   if (!selected) {
      Logger.error(
         `Submodule '${target}' not found. Available: ${candidatePaths.join(', ')}.`,
         'submodule'
      );
      return 1;
   }

   const destination = path.resolve(mainRoot, selected);
   if (!fs.existsSync(destination)) {
      Logger.error(
         `Submodule '${selected}' is not initialized. Run 'git submodule update --init ${selected}'.`,
         'submodule'
      );
      return 1;
   }

   await scheduleChangeDir(destination);
   return 0;
}

type InlineSubmoduleMode = 'off' | 'internal' | 'all';

function deriveSubmodulePathFromRepository(repository: string): string {
   const normalized = repository
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .replace(/\.git$/i, '');
   const match = normalized.match(/([^/:]+)$/);
   const derived = match?.[1]?.trim() || '';
   if (!derived) {
      throw new Error(`Unable to derive submodule path from repository '${repository}'.`);
   }
   return derived;
}

function splitArgsByTerminator(tokens: ArgsSet): { head: ArgsSet; tail: string[] } {
   const terminatorIndex = tokens.indexOf('--');
   if (terminatorIndex === -1) {
      return {
         head: tokens.slice(),
         tail: [],
      };
   }

   return {
      head: tokens.slice(0, terminatorIndex),
      tail: tokens.slice(terminatorIndex + 1).toArray(),
   };
}

function assertNoUnsupportedOptions(tokens: ArgsSet, command: string): void {
   const unsupported = tokens.find((token) => token.startsWith('-'));
   if (unsupported) {
      throw new Error(`Unsupported option for 'submodule ${command}': ${unsupported}`);
   }
}

function parseAddArgs(
   tokens: ArgsSet,
   defaultQuiet: boolean
): {
   submoduleUrl: string;
   submodulePath: string;
   options: AddSubmoduleOptions;
} {
   const { head, tail } = splitArgsByTerminator(tokens);
   const options: AddSubmoduleOptions = { quiet: defaultQuiet };

   if (head.popOption('-q') || head.popOption('--quiet')) options.quiet = true;
   if (head.popOption('-f') || head.popOption('--force')) options.force = true;

   const branch = head.popAssertValue('--branch') || head.popAssertValue('-b');
   if (branch) options.branch = branch;

   const name = head.popAssertValue('--name');
   if (name) options.name = name;

   const reference = head.popAssertValue('--reference');
   if (reference) options.reference = reference;

   assertNoUnsupportedOptions(head, 'add');

   const positionals = [...head.toArray(), ...tail];

   if (positionals.length === 0) {
      throw new Error(`'submodule add' requires <repository> [path].`);
   }

   if (positionals.length > 2) {
      throw new Error(`'submodule add' accepts at most two positional arguments.`);
   }

   const submoduleUrl = positionals[0];
   const submodulePath = positionals[1] || deriveSubmodulePathFromRepository(submoduleUrl);

   return {
      submoduleUrl,
      submodulePath,
      options,
   };
}

function parseUpdateArgs(tokens: ArgsSet, defaultQuiet: boolean): UpdateSubmoduleOptions {
   const { head, tail } = splitArgsByTerminator(tokens);
   const options: UpdateSubmoduleOptions = {
      quiet: defaultQuiet,
      init: false,
      recursive: false,
      strategy: 'checkout',
   };

   if (head.popOption('-q') || head.popOption('--quiet')) options.quiet = true;
   if (head.popOption('--init')) options.init = true;
   if (head.popOption('--remote')) options.remote = true;
   if (head.popOption('-N') || head.popOption('--no-fetch')) options.noFetch = true;
   if (head.popOption('-f') || head.popOption('--force')) options.force = true;

   if (head.popOption('--checkout')) options.strategy = 'checkout';
   if (head.popOption('--merge')) options.strategy = 'merge';
   if (head.popOption('--rebase')) options.strategy = 'rebase';

   if (head.popOption('--recommend-shallow')) options.recommendShallow = true;
   if (head.popOption('--no-recommend-shallow')) options.recommendShallow = false;

   const reference = head.popAssertValue('--reference');
   if (reference) options.reference = reference;

   if (head.popOption('--recursive')) options.recursive = true;
   if (head.popOption('--single-branch')) options.singleBranch = true;
   if (head.popOption('--no-single-branch')) options.singleBranch = false;

   const filter = head.popAssertValue('--filter');
   if (filter) options.filter = filter;

   assertNoUnsupportedOptions(head, 'update');

   const paths = [...head.toArray(), ...tail];

   if (paths.length > 0) {
      options.paths = paths;
   }

   return options;
}

function parseDeinitArgs(tokens: ArgsSet, defaultQuiet: boolean): DeinitSubmoduleOptions {
   const { head, tail } = splitArgsByTerminator(tokens);
   const options: DeinitSubmoduleOptions = {
      quiet: defaultQuiet,
      force: false,
      all: false,
   };

   if (head.popOption('-q') || head.popOption('--quiet')) options.quiet = true;
   if (head.popOption('-f') || head.popOption('--force')) options.force = true;
   if (head.popOption('--all')) options.all = true;

   assertNoUnsupportedOptions(head, 'deinit');

   const paths = [...head.toArray(), ...tail];

   if (options.all && paths.length > 0) {
      throw new Error(`'submodule deinit' does not allow paths together with '--all'.`);
   }

   if (!options.all && paths.length === 0) {
      throw new Error(`'submodule deinit' requires '--all' or at least one path.`);
   }

   if (paths.length > 0) {
      options.paths = paths;
   }

   return options;
}

async function getInlineMode(): Promise<InlineSubmoduleMode> {
   const config = await getConfig();
   const mode = config.get<InlineSubmoduleMode>('useInlineSubmodule', 'internal');
   if (mode === 'off' || mode === 'internal' || mode === 'all') return mode;
   return 'internal';
}

export async function handleUserSubmoduleCommand(
   ctx: GdxContext,
   subcommandArgs: ArgsSet,
   quiet: boolean
): Promise<number | null> {
   const mode = await getInlineMode();
   if (mode !== 'all') return null;

   const worktreePath = await getRepoRootCached(ctx.git$);
   const subcommand = subcommandArgs[0];
   subcommandArgs = subcommandArgs.slice(1);

   try {
      if (subcommand === 'add') {
         const parsed = parseAddArgs(subcommandArgs, quiet);
         await addSubmodule(
            ctx.git$,
            worktreePath,
            parsed.submoduleUrl,
            parsed.submodulePath,
            parsed.options
         );
         return 0;
      }

      if (subcommand === 'update') {
         const options = parseUpdateArgs(subcommandArgs, quiet);
         await updateSubmodules(ctx.git$, worktreePath, options);
         return 0;
      }

      if (subcommand === 'deinit') {
         const options = parseDeinitArgs(subcommandArgs, quiet);
         await deinitSubmodules(ctx.git$, worktreePath, options);
         return 0;
      }
   } catch (error) {
      Logger.error((error as Error).message, 'submodule');
      return 1;
   }

   return null;
}

export const help = {
   long: () => {
      const bright = ncc('Bright');
      const cyan = ncc('Cyan');
      const reset = ncc();
      return strWrap(
         litedent`
         ${bright + _2PointGradient('SUBMODULE SWITCH', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
         Jump into a submodule directory from the parent repository.

         ${bright + _2PointGradient('DESCRIPTION', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
         Resolve the target submodule by full path, unique prefix, or unique leaf name and then
         schedule an auto-cd into it. Use "main" to jump back to the parent repository root.
         Requires shell integration to change directories.

         ${bright + _2PointGradient('REQUIREMENTS', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
         Shell integration must be enabled using ${cyan}${EXECUTABLE_NAME} --init${reset}.
         Submodules must be initialized (use ${cyan}git submodule update --init${reset}).
         `,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            mode: 'softboundary',
            indent: '  ',
         }
      );
   },
   short: 'Jump into a submodule directory (requires shell integration).',
   usage: () => {
      const cyan = ncc('Cyan');
      const dim = ncc('Dim');
      const reset = ncc();
      return strWrap(
         litedent`
         ${cyan}${EXECUTABLE_NAME} submodule switch ${dim}<path|name|main>${reset}

         Examples:
            ${cyan}${EXECUTABLE_NAME} submodule switch vendor/sdk ${reset + dim}# Switch by full path${reset}
            ${cyan}${EXECUTABLE_NAME} submodule switch sdk        ${reset + dim}# Switch by unique name${reset}
            ${cyan}${EXECUTABLE_NAME} submodule switch main       ${reset + dim}# Back to parent repo${reset}`,
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
      switch: {},
   },
} as const satisfies CommandStructure;

export default {
   switch: switchSubmodule,
   handleUserCommand: handleUserSubmoduleCommand,
};
