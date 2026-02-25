import path from 'path';

import { ncc, strWrap } from '@lib/Tools';

import { CommandHelpObj, CommandStructure, GdxContext } from '@/common/types';
import { EXECUTABLE_NAME, GDX_RESULT_FILE, GDX_VPALETTE } from '@/consts';
import * as fs from '@/modules/fs';
import { getRepoRootCached, getSubmodules } from '@/modules/git';
import { _2PointGradient } from '@/modules/graphics';
import { scheduleChangeDir } from '@/modules/shell';
import Logger from '@/utils/logger';
import { progressiveMatch } from '@/utils/utilities';
import global from '@/global';

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

   const repoRoot = await getRepoRootCached(ctx.git$);
   const submodules = await getSubmodules(ctx.git$, repoRoot);
   if (submodules.length === 0) {
      Logger.error('No submodules found in this repository.', 'submodule');
      return 1;
   }

   const normalizedTarget = target
      .replace(/\\/g, '/')
      .replace(/^\.\/+/, '')
      .replace(/\/+$/, '');
   const candidatePaths = submodules.map((submodule) =>
      submodule.path.replace(/\\/g, '/').replace(/\/+$/, '')
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

   const destination = path.resolve(repoRoot, selected);
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

export const help = {
   long: () => {
      const bright = ncc('Bright');
      const cyan = ncc('Cyan');
      const reset = ncc();
      return strWrap(
         `
${bright + _2PointGradient('SUBMODULE SWITCH', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
Jump into a submodule directory from the parent repository.

${bright + _2PointGradient('DESCRIPTION', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
Resolve the target submodule by full path, unique prefix, or unique leaf name and then
schedule an auto-cd into it. Requires shell integration to change directories.

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
         `
  ${cyan}${EXECUTABLE_NAME} submodule switch ${dim}<path|name>${reset}

Examples:
   ${cyan}${EXECUTABLE_NAME} submodule switch vendor/sdk ${reset + dim}# Switch by full path${reset}
   ${cyan}${EXECUTABLE_NAME} submodule switch sdk        ${reset + dim}# Switch by unique name${reset}`,
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
};
