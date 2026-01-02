import fs from 'fs/promises';
import path from 'path';

import { ncc, strWrap, yuString } from '@lib/Tools';

import { GdxContext } from '../common/types';
import { $, $inherit, $prompt } from '../utils/shell';
import { quickPrint } from '../utils/utilities';
import { EXECUTABLE_NAME, ONE_DAY_MS, TEMP_DIR } from '../consts';

import { COLOR } from '../consts';
import { _2PointGradient } from '../utils/graphics';

export default async function clear(ctx: GdxContext): Promise<number> {
   const { git$, args } = ctx;

   const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout
      .trim()
      .replace(/\//g, '-');
   const repoRoot = (await $`${git$} rev-parse --show-toplevel`).stdout.trim();
   const projectName = path.basename(repoRoot);
   const osTemp = TEMP_DIR;
   const backupFileBlob = `${projectName}_${branchName}_backup_*.patch`;

   // backup files naming pattern
   const prefix = `${projectName}_${branchName}_backup_`;
   const suffix = `.patch`;

   // LIST subcommand
   if (args.includes('list')) {
      quickPrint(`${ncc('Cyan')}Project:${ncc()} ${projectName}`);
      quickPrint(`${ncc('Cyan')}Branch:${ncc()} ${branchName}`);
      quickPrint(`${ncc('Cyan')}Backup location:${ncc()} ${osTemp}`);
      quickPrint(`${ncc('Cyan')}Use \`git clear pardon\` to restore the latest backup.${ncc()}\n`);
      quickPrint(
         `${ncc('Cyan')}Looking for backup patch files matching:${ncc()} ${backupFileBlob}\n`
      );

      const backupFiles = await getBackupFiles(osTemp, prefix, suffix);

      if (backupFiles.length === 0) {
         quickPrint(
            `${ncc('Yellow')}No backup patch files found for project '${projectName}' on branch '${branchName}'.${ncc()}`
         );
         return 0;
      }

      const now = new Date();
      for (let i = 0; i < backupFiles.length; i++) {
         const file = backupFiles[i];
         const ageDays = (now.getTime() - file.stats.mtime.getTime()) / ONE_DAY_MS;
         const createdStr = file.stats.mtime.toISOString().replace('T', ' ').split('.')[0];

         let color = ncc('Dim');
         if (file.stats.mtime.toDateString() === now.toDateString()) {
            color = ncc('White');
         } else if (ageDays >= 6) {
            color = ncc('Red'); // Dim Red isn't standard, using Red
         }

         quickPrint(`${color}backup@${i}: ${createdStr} - ${file.name}${ncc()}`);
      }
      return 0;
   }

   const isForce = args.includes('-f') || args.includes('--force');

   // Clean up old backup files (older than 7 days)
   // We do this synchronously here for simplicity, unlike the async job in PS
   const allBackupFiles = await getBackupFiles(osTemp, prefix, suffix);
   const sevenDaysAgo = new Date();
   sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

   for (const file of allBackupFiles) {
      if (file.stats.mtime < sevenDaysAgo) {
         try {
            await fs.unlink(file.path);
            allBackupFiles.splice(allBackupFiles.indexOf(file), 1);
         } catch (e) {
            console.error(`Failed to delete old backup file: ${file.path}`, e);
         }
      }
   }

   // PARDON subcommand
   if (args.includes('pardon')) {
      const hasCachedChanges = (await $`${git$} diff --cached --name-only`).stdout.length > 0;
      const hasChanges = hasCachedChanges || (await $`${git$} diff --name-only`).stdout.length > 0;

      if (hasChanges) {
         if (!isForce) {
            quickPrint(
               `${ncc('Red')}Working Directory is dirty, aborting pardon to prevent unintended data loss. (use \`-f\` to force)${ncc()}`
            );
            await $inherit`${git$} status`;
            return 1;
         }

         // Clean working directory
         await $inherit`${git$} reset --hard HEAD`;
         await $inherit`${git$} clean -fd`;
      }

      if (allBackupFiles.length === 0) {
         quickPrint(
            `${ncc('Red')}No backup patch file found for branch '${branchName}'. Pardon failed.${ncc()}`
         );
         return 1;
      }

      const latestBackup = allBackupFiles[0];
      const oneDayAgo = new Date();
      oneDayAgo.setDate(oneDayAgo.getDate() - 1);

      if (!isForce && latestBackup.stats.mtime < oneDayAgo) {
         quickPrint(
            `${ncc('Yellow')}Latest backup patch file is older than 1 day. Do you want to proceed with the pardon? (y/n)${ncc()}`
         );

         const answer = await $prompt("Type 'y' to confirm: ");
         if (answer.toLowerCase() !== 'y') {
            quickPrint(`${ncc('Red')}Pardon aborted.${ncc()}`);
            return 1;
         }
      }

      try {
         await $`${git$} apply ${latestBackup.path}`;
         await fs.unlink(latestBackup.path);
         quickPrint(
            `${ncc('Cyan')}Pardon applied successfully from backup: ${ncc('Bright')}${latestBackup.path}${ncc()}`
         );
         await $inherit`${git$} status`;
      } catch (err) {
         quickPrint(
            `${ncc('Red')}Failed to apply patch. Pardon aborted.${ncc()}\n` +
               yuString(err, { color: true })
         );
         return 1;
      }
      return 0;
   }

   // CLEAR (Default)
   if (args.includes('-a') || args.includes('--all')) {
      quickPrint(
         `${ncc('Cyan')}Staging all changes (including untracked files) before clearing...${ncc()}`
      );
      await $inherit`${git$} add -A`;
   }

   const diffUnstaged = await $`${git$} diff`;
   const diffStaged = await $`${git$} diff --cached`;
   const hasCachedChanges = diffStaged.stdout.length > 0;
   const hasChanges = hasCachedChanges || diffUnstaged.stdout.length > 0;

   if (!hasChanges) {
      quickPrint(`${ncc('Cyan')}No changes to clear. Working directory is clean.${ncc()}`);
      await $inherit`${git$} status`;
      return 0;
   }

   if (!isForce) {
      const hasUntracked =
         (await $`${git$} ls-files --others --exclude-standard`).stdout.length > 0;
      if (hasUntracked) {
         // LINK: mmhrb3j string literal in spec
         quickPrint(
            `${ncc('Yellow')}Untracked files will be removed during clear operation. Clear aborted.\nUse \`-f\` to force.${ncc()}`
         );
         await $inherit`${git$} status`;
         return 1;
      }
   }

   const timestamp = new Date()
      .toISOString()
      .replace(/[-:T.]/g, '')
      .slice(0, 14); // yyyyMMddHHmmss
   const backupFileName = `${projectName}_${branchName}_backup_${timestamp}.patch`;
   const backupFilePath = path.join(osTemp, backupFileName);

   // Create patch file
   // We need to combine diff and diff --cached
   await fs.writeFile(backupFilePath, diffUnstaged.stdout + '\n' + diffStaged.stdout);

   quickPrint(
      `${ncc('Cyan')}Backup of staged changes saved to: ${ncc('Bright')}${backupFilePath}${ncc()}\n${ncc('Cyan')}(\`git clear pardon\` to undo)${ncc()}`
   );

   await $inherit`${git$} reset --hard HEAD`;
   await $inherit`${git$} clean -fd`;

   await $inherit`${git$} status`;
   return 0;
}

export const help = {
   long: () =>
      strWrap(
         `
${ncc('Bright') + _2PointGradient('CLEAR', COLOR.Zinc400, COLOR.Zinc100, 0.2)}
Safely backup and clear local working changes.

${ncc('Bright') + _2PointGradient('DESCRIPTION', COLOR.Zinc400, COLOR.Zinc100, 0.2)}
Creates a patch file containing the current unstaged and staged changes, stores it in the OS temporary directory and then resets the working tree to a clean HEAD via \`git reset --hard\` and \`git clean -fd\`. The latest patch is kept so you can restore it with ${ncc('Cyan')}${EXECUTABLE_NAME} clear pardon${ncc()}.

${ncc('Bright') + _2PointGradient('SUBCOMMANDS', COLOR.Zinc400, COLOR.Zinc100, 0.2)}
- list: Show available backup patch files for this project/branch.
- pardon: Restore the most recent backup patch (requires clean or forced conditions).

${ncc('Bright') + _2PointGradient('SAFETY', COLOR.Zinc400, COLOR.Zinc100, 0.2)}
By default the command refuses to run if untracked files would be removed unless forced with \`-f\`/\`--force\`. Use \`-a\`/\`--all\` to stage untracked files before creating a backup.
`,
         100,
         {
            firstIndent: '  ',
            mode: 'softboundery',
            indent: '  ',
         }
      ),
   short: 'Backup and clear local changes, with a restore (pardon) option.',
   usage: () =>
      strWrap(
         `
${ncc('Cyan')}${EXECUTABLE_NAME} clear ${ncc('Dim')}[list|pardon] [-f|--force] [-a|--all]${ncc()}

Examples:
   ${ncc('Cyan')}${EXECUTABLE_NAME} clear ${ncc() + ncc('Dim')}# Create backup patch and clear working tree${ncc()}
   ${ncc('Cyan')}${EXECUTABLE_NAME} clear list ${ncc() + ncc('Dim')}# Show recent backup patches${ncc()}
   ${ncc('Cyan')}${EXECUTABLE_NAME} clear pardon ${ncc() + ncc('Dim')}# Restore the latest backup patch${ncc()}
   ${ncc('Cyan')}${EXECUTABLE_NAME} clear -a ${ncc() + ncc('Dim')}# Stage untracked files then clear${ncc()}`,
         100,
         {
            firstIndent: '  ',
            mode: 'softboundery',
            indent: '  ',
         }
      ),
};

async function getBackupFiles(backupDir: string, prefix: string, suffix: string) {
   const files = await fs.readdir(backupDir);
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
