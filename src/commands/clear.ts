import * as fs from '@/modules/fs';
import crypto from 'crypto';
import nodeFs from 'fs';
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

interface ClearBackupIndexEntry {
   path: string;
   name: string;
   createdAt: string;
}

interface ClearBackupIndex {
   version: 1;
   backups: ClearBackupIndexEntry[];
}

interface ClearBackupFile {
   name: string;
   path: string;
   stats: nodeFs.Stats;
}

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
   const backupDir = getClearBackupDir(repoRoot, branchName);
   const backupFileBlob = `${projectName}_${branchName}_backup_*.patch`;

   // LIST subcommand
   if (subCommand === 'list') {
      quickPrint(`${SGR.cyan}Project:${SGR.reset} ${projectName}`);
      quickPrint(`${SGR.cyan}Branch:${SGR.reset} ${branchName}`);
      quickPrint(`${SGR.cyan}Backup location:${SGR.reset} ${backupDir}`);
      quickPrint(`${SGR.cyan}Use \`git clear pardon\` to restore the latest backup.${SGR.reset}\n`);
      quickPrint(
         `${SGR.cyan}Looking for backup patch files matching:${SGR.reset} ${backupFileBlob}\n`
      );

      const backupFiles = await getBackupFiles(backupDir);

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
   const allBackupFiles = await getBackupFiles(backupDir);
   const sevenDaysAgo = new Date();
   sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

   for (const file of allBackupFiles) {
      if (file.stats.mtime < sevenDaysAgo) {
         try {
            fs.unlinkSync(file.path);
            await removeBackupIndexEntry(backupDir, file.path);
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
         await removeBackupIndexEntry(backupDir, latestBackup.path);
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
   const backupFilePath = path.join(backupDir, backupFileName);

   // Stage all changes (including untracked) to capture them in the patch
   await $inherit`${git$} add -A`;

   await ensureClearBackupDir(backupDir);
   try {
      nodeFs.closeSync(nodeFs.openSync(backupFilePath, 'wx', 0o600));
      const backupExitCode = await execGit(
         git$,
         ['-c', 'color.ui=never', 'diff', '--cached', '--binary', '--no-color', '--no-ext-diff'],
         backupFilePath,
         '>'
      );
      if (backupExitCode !== 0) {
         throw new Error(`git diff exited with code ${backupExitCode}.`);
      }
      await appendBackupIndexEntry(backupDir, {
         path: backupFilePath,
         name: backupFileName,
         createdAt: new Date().toISOString(),
      });
   } catch (err) {
      await fs.unlink(backupFilePath).catch(() => undefined);
      Logger.error(
         `Failed to create backup patch. Clear aborted.\n${yuString(err, { color: true })}`,
         'clear'
      );
      return 1;
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
         Creates a patch file containing the current unstaged, staged, and untracked changes, stores it in gdx's private backup directory and then resets the working tree to a clean HEAD via \`${SGR.cyan}git reset --hard${SGR.reset}\` and \`${SGR.cyan}git clean -fd${SGR.reset}\`. The latest patch is kept so you can restore it with \`${SGR.cyan}${EXECUTABLE_NAME} clear pardon${SGR.reset}\`.

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

function getDynamicTempDir(): string {
   const envTempDir = process.env.GDX_TEMP_DIR;
   if (envTempDir) {
      const testTempDir = path.join(envTempDir, 'tmp');
      if (process.env.NODE_ENV === 'test' && fs.existsSync(testTempDir)) {
         return testTempDir;
      }
      return envTempDir;
   }

   return TEMP_DIR;
}

function getClearBackupRoot(): string {
   return path.join(getDynamicTempDir(), 'gdx', 'clear');
}

function getClearBackupDir(repoRoot: string, branchName: string): string {
   const repoHash = crypto.createHash('sha256').update(repoRoot).digest('hex').slice(0, 16);
   return path.join(getClearBackupRoot(), repoHash, branchName);
}

function getClearBackupIndexPath(backupDir: string): string {
   return path.join(backupDir, 'index.json');
}

async function ensureClearBackupDir(backupDir: string): Promise<void> {
   await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
   if (process.platform !== 'win32') {
      await nodeFs.promises.chmod(backupDir, 0o700);
   }
}

async function readBackupIndex(backupDir: string): Promise<ClearBackupIndex> {
   try {
      const index = JSON.parse(
         await fs.readFile(getClearBackupIndexPath(backupDir), 'utf-8')
      ) as ClearBackupIndex;
      if (index.version !== 1 || !Array.isArray(index.backups)) {
         return { version: 1, backups: [] };
      }
      return index;
   } catch {
      return { version: 1, backups: [] };
   }
}

async function writeBackupIndex(backupDir: string, index: ClearBackupIndex): Promise<void> {
   await ensureClearBackupDir(backupDir);
   await fs.writeFile(getClearBackupIndexPath(backupDir), JSON.stringify(index, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
   });
}

async function appendBackupIndexEntry(
   backupDir: string,
   entry: ClearBackupIndexEntry
): Promise<void> {
   const index = await readBackupIndex(backupDir);
   index.backups = [
      entry,
      ...index.backups.filter((existing) => existing.path !== entry.path),
   ];
   await writeBackupIndex(backupDir, index);
}

async function removeBackupIndexEntry(backupDir: string, backupPath: string): Promise<void> {
   const index = await readBackupIndex(backupDir);
   const resolvedBackupPath = path.resolve(backupPath);
   index.backups = index.backups.filter((entry) => path.resolve(entry.path) !== resolvedBackupPath);
   await writeBackupIndex(backupDir, index);
}

async function getBackupFiles(backupDir: string): Promise<ClearBackupFile[]> {
   const index = await readBackupIndex(backupDir);
   const backupDirRealPath = path.resolve(backupDir);
   const backups: ClearBackupFile[] = [];
   const keptEntries: ClearBackupIndexEntry[] = [];

   for (const entry of index.backups) {
      const entryPath = path.resolve(entry.path);
      if (entryPath !== backupDirRealPath && !entryPath.startsWith(`${backupDirRealPath}${path.sep}`)) {
         continue;
      }

      try {
         const lstat = nodeFs.lstatSync(entryPath);
         if (!lstat.isFile()) continue;
         const stats = await fs.stat(entryPath);
         backups.push({ name: path.basename(entryPath), path: entryPath, stats });
         keptEntries.push(entry);
      } catch {
         // Drop stale metadata entries below.
      }
   }

   if (keptEntries.length !== index.backups.length) {
      await writeBackupIndex(backupDir, { version: 1, backups: keptEntries });
   }

   return backups.sort((a, b) => b.stats.mtime.getTime() - a.stats.mtime.getTime());
}
