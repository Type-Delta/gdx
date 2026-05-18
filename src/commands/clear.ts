import * as fs from '@/modules/fs';
import path from 'path';

import { strWrap, yuString } from '@lib/Tools';

import { CommandHelpObj, CommandStructure, GdxContext } from '../common/types';
import { $, $inherit, $prompt, execGit } from '../modules/shell';
import { progressiveMatch, quickPrint } from '../utils/utilities';
import { EXECUTABLE_NAME, ONE_DAY_MS, TEMP_DIR, SGR } from '../consts';
import Logger from '../utils/logger';
import { GDX_VPALETTE } from '../consts';
import { _2PointGradient } from '../modules/graphics';
import global from '@/global';
import { getRepoRootCached, revParseCached } from '@/modules/git';
import litedent from '@/utils/litedent';

export default async function clear(ctx: GdxContext): Promise<number> {
   const { git$, args } = ctx;

   const inputCommand = args[1]?.toLowerCase();
   const { match: subCommand } = progressiveMatch(inputCommand, ['list', 'pardon']);

   const [branchName, repoRoot] = await Promise.all([
      revParseCached(git$, ['--abbrev-ref', 'HEAD']).then((branch) =>
         branch.trim().replace(/\//g, '-')
      ),
      getRepoRootCached(git$),
   ]);
   const projectName = path.basename(repoRoot);
   const osTemp = TEMP_DIR;
   const backupFileBlob = `${projectName}_${branchName}_backup_*.patch`;

   // backup files naming pattern
   const prefix = `${projectName}_${branchName}_backup_`;
   const suffix = `.patch`;

   // LIST subcommand
   if (subCommand === 'list') {
      quickPrint(`${SGR.cyan}Project:${SGR.reset} ${projectName}`);
      quickPrint(`${SGR.cyan}Branch:${SGR.reset} ${branchName}`);
      quickPrint(`${SGR.cyan}Backup location:${SGR.reset} ${osTemp}`);
      quickPrint(`${SGR.cyan}Use \`git clear pardon\` to restore the latest backup.${SGR.reset}\n`);
      quickPrint(
         `${SGR.cyan}Looking for backup patch files matching:${SGR.reset} ${backupFileBlob}\n`
      );

      const backupFiles = await getBackupFiles(osTemp, prefix, suffix);

      if (backupFiles.length === 0) {
         quickPrint(
            `${SGR.yellow}No backup patch files found for project '${projectName}' on branch '${branchName}'.${SGR.reset}`
         );
         return 0;
      }

      const now = new Date();
      for (let i = 0; i < backupFiles.length; i++) {
         const file = backupFiles[i];
         const ageDays = (now.getTime() - file.stats.mtime.getTime()) / ONE_DAY_MS;
         const createdStr = file.stats.mtime.toISOString().replace('T', ' ').split('.')[0];

         let color = SGR.dim;
         if (file.stats.mtime.toDateString() === now.toDateString()) {
            color = SGR.white;
         } else if (ageDays >= 6) {
            color = SGR.red; // Dim Red isn't standard, using Red
         }

         quickPrint(`${color}backup@${i}: ${createdStr} - ${file.name}${SGR.reset}`);
      }
      return 0;
   }

   // Clean up old backup files (older than 7 days)
   // We do this synchronously here for simplicity, unlike the async job in PS
   const allBackupFiles = await getBackupFiles(osTemp, prefix, suffix);
   const sevenDaysAgo = new Date();
   sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

   for (const file of allBackupFiles) {
      if (file.stats.mtime < sevenDaysAgo) {
         try {
            fs.unlinkSync(file.path);
            allBackupFiles.splice(allBackupFiles.indexOf(file), 1);
         } catch (e) {
            Logger.error(
               `Failed to delete old backup file: ${file.path}\n${yuString(e, { color: true })}`,
               'clear'
            );
         }
      }
   }

   // PARDON subcommand
   if (subCommand === 'pardon') {
      const hasCachedChanges = (await $`${git$} diff --cached --name-only`).stdout.length > 0;
      const hasChanges = hasCachedChanges || (await $`${git$} diff --name-only`).stdout.length > 0;

      if (hasChanges) {
         Logger.error(
            'Working Directory is dirty, aborting pardon to prevent unintended data loss. Please clear your workspace first.',
            'clear'
         );
         await $inherit`${git$} status`;
         return 1;
      }

      if (allBackupFiles.length === 0) {
         Logger.error(
            `No backup patch file found for branch '${branchName}'. Pardon failed.`,
            'clear'
         );
         return 1;
      }

      const latestBackup = allBackupFiles[0];
      const oneDayAgo = new Date();
      oneDayAgo.setDate(oneDayAgo.getDate() - 1);

      if (latestBackup.stats.mtime < oneDayAgo) {
         Logger.warn(
            'Latest backup patch file is older than 1 day. Do you want to proceed with the pardon? (y/n)',
            'clear'
         );

         const answer = await $prompt("Type 'y' to confirm: ");
         if (answer.toLowerCase() !== 'y') {
            Logger.error('Pardon aborted.', 'clear');
            return 1;
         }
      }

      try {
         await $inherit`${git$} apply ${latestBackup.path}`;
         fs.unlinkSync(latestBackup.path);
         quickPrint(
            `${SGR.cyan}Pardon applied successfully from backup: ${SGR.bright}${latestBackup.path}${SGR.reset}`
         );
         await $inherit`${git$} status`;
      } catch (err) {
         Logger.error(
            `Failed to apply patch. Pardon aborted.\n${yuString(err, { color: true })}`,
            'clear'
         );
         return 1;
      }
      return 0;
   }

   // CLEAR (Default)
   const [hasCachedChanges, hasUnstagedChanges, hasUntrackedFiles] = await Promise.all([
      $`${git$} diff --cached --name-only`.then((c) => c.stdout.length > 0),
      $`${git$} diff --name-only`.then((c) => c.stdout.length > 0),
      $`${git$} ls-files --others --exclude-standard`.then((c) => c.stdout.length > 0),
   ]);

   if (!hasCachedChanges && !hasUnstagedChanges && !hasUntrackedFiles) {
      quickPrint(`${SGR.cyan}No changes to clear. Working directory is clean.${SGR.reset}`);
      await $inherit`${git$} status`;
      return 0;
   }

   const timestamp = new Date()
      .toISOString()
      .replace(/[-:T.]/g, '')
      .slice(0, 14); // yyyyMMddHHmmss
   const backupFileName = `${projectName}_${branchName}_backup_${timestamp}.patch`;
   const backupFilePath = path.join(osTemp, backupFileName);

   // Stage all changes (including untracked) to capture them in the patch
   await $inherit`${git$} add -A`;

   const backupExitCode = await execGit(
      git$,
      ['-c', 'color.ui=never', 'diff', '--cached', '--binary', '--no-color', '--no-ext-diff'],
      backupFilePath,
      '>'
   );

   if (backupExitCode !== 0) {
      Logger.error('Failed to create backup patch. Clear aborted.', 'clear');
      return backupExitCode || 1;
   }

   quickPrint(
      `${SGR.cyan}Backup of all changes saved to: ${SGR.bright}${backupFilePath}${SGR.reset}\n${SGR.cyan}(\`git clear pardon\` to undo)${SGR.reset}`
   );

   await $inherit`${git$} reset --hard HEAD`;
   await $inherit`${git$} clean -fd`;

   await $inherit`${git$} status`;
   return 0;
}

export const help = {
   long: () => {
      return strWrap(
         litedent`
         ${SGR.bright + _2PointGradient('CLEAR', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         Safely backup and clear local working changes.

         ${SGR.bright + _2PointGradient('DESCRIPTION', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         Creates a patch file containing the current unstaged, staged, and untracked changes, stores it in the OS temporary directory and then resets the working tree to a clean HEAD via \`${SGR.cyan}git reset --hard${SGR.reset}\` and \`${SGR.cyan}git clean -fd${SGR.reset}\`. The latest patch is kept so you can restore it with \`${SGR.cyan}${EXECUTABLE_NAME} clear pardon${SGR.reset}\`.

         ${SGR.bright + _2PointGradient('SUBCOMMANDS', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         - list: Show available backup patch files for this project/branch.
         - pardon: Restore the most recent backup patch.

         ${SGR.bright + _2PointGradient('SAFETY', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         All files (tracked and untracked) are backed up before clearing. Pardon requires a clean working directory.
         `,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            mode: 'softboundary',
            indent: '  ',
         }
      );
   },
   short: 'Backup and clear local changes, with a restore (pardon) option.',
   usage: () => {
      return strWrap(
         litedent`
         ${SGR.cyan}${EXECUTABLE_NAME} clear ${SGR.dim}[list|pardon]${SGR.reset}

         Examples:
            ${SGR.cyan}${EXECUTABLE_NAME} clear ${SGR.reset + SGR.dim}# Create backup patch and clear working tree${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} clear list ${SGR.reset + SGR.dim}# Show recent backup patches${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} clear pardon ${SGR.reset + SGR.dim}# Restore the latest backup patch${SGR.reset}`,
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
   $root: ['list', 'pardon'],
} as const satisfies CommandStructure;

async function getBackupFiles(backupDir: string, prefix: string, suffix: string) {
   const files = fs.readdirSync(backupDir);
   const matchedFiles = files.filter((f) => f.startsWith(prefix) && f.endsWith(suffix));

   const fileStats = await Promise.all(
      matchedFiles.map(async (f) => {
         const fullPath = path.join(backupDir, f);
         const stats = await fs.stat(fullPath);
         return { name: f, path: fullPath, stats };
      })
   );

   return fileStats.sort((a, b) => b.stats.mtime.getTime() - a.stats.mtime.getTime());
}
