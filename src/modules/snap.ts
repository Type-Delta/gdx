import crypto from 'crypto';
import path from 'path';

import * as fs from '@/modules/fs';

import {
   CURRENT_DIR,
   SNAP_FILE_EXTENSION,
   SNAP_HASH_LENGTH,
   SNAP_META_FILE_NAME,
   SNAP_SHORT_HASH_LENGTH,
   SNAP_VERSION,
   TEMP_DIR,
} from '@/consts';
import { getGitConfigValue, getRepoRootCached, revParseCached } from '@/modules/git';
import { $, spinner } from '@/modules/shell';
import { asUnixPath } from '@/utils/path';
import { walkDir } from '@/modules/fs';

type SnapshotType = 'worktree' | 'full';
type SnapshotEntryKind = 'file';

interface SnapshotCanonicalMetadata {
   version: 1;
   type: SnapshotType;
   repoRoot: string;
   repoLabel: string;
   repoIdentity: string;
   rootCommit: string;
   headCommit: string;
   headRef: string | null;
   branchName: string | null;
   originUrl: string | null;
}

export interface SnapMetadata extends SnapshotCanonicalMetadata {
   createdAt: string;
}

interface SnapshotEntry {
   path: string;
   data: Uint8Array;
   kind: SnapshotEntryKind;
}

interface SnapshotPathStatus {
   status: string;
   path: string;
   oldPath?: string;
}

interface LoadedSnapshot {
   archivePath: string;
   hash: string;
   meta: SnapMetadata;
   entries: Map<string, Uint8Array>;
}

type SnapshotRepoInfo = SnapshotCanonicalMetadata;

interface SnapshotIndexEntry {
   hash: string;
   archivePath: string;
   meta: SnapMetadata;
}

export type SnapshotListEntry = SnapshotIndexEntry;

export interface CreateSnapshotResult {
   hash: string;
   archivePath: string;
   existed: boolean;
   meta: SnapMetadata;
}

type FflateModule = Awaited<typeof import('fflate')>;

let fflateModulePromise: Promise<FflateModule> | null = null;

/**
 * Creates a deterministic worktree snapshot archive for the current repository.
 * @param git$ - Git executable path or command array.
 * @returns Snapshot creation result with hash and archive path.
 */
export async function createWorktreeSnapshot(
   git$: string | string[]
): Promise<CreateSnapshotResult> {
   const [repoInfo, stagedPatchRaw, unstagedPatchRaw, stagedStatuses, untrackedOutput] = await Promise.all([
      getSnapshotRepoInfo(git$),
      runGitStdout(git$, [
         '-c',
         'color.ui=never',
         'diff',
         '--cached',
         '--binary',
         '--no-color',
         '--no-ext-diff',
      ]),
      runGitStdout(git$, [
         '-c',
         'color.ui=never',
         'diff',
         '--binary',
         '--no-color',
         '--no-ext-diff',
      ]),
      runGitStdout(git$, ['diff', '--cached', '--name-status', '-z'])
         .then(parseNameStatusNullSeparated),
      runGitStdout(git$, [
         '-c',
         'core.quotePath=false',
         'ls-files',
         '--others',
         '--exclude-standard',
         '-z',
      ]),
   ]);

   const repoRoot = repoInfo.repoRoot;
   const encoder = new TextEncoder();
   const entries: SnapshotEntry[] = [
      {
         path: 'worktree/staged.patch',
         data: encoder.encode(normalizePatchText(stagedPatchRaw)),
         kind: 'file',
      },
      {
         path: 'worktree/unstaged.patch',
         data: encoder.encode(normalizePatchText(unstagedPatchRaw)),
         kind: 'file',
      },
      {
         path: 'worktree/staged-status.json',
         data: encoder.encode(stableStringify(stagedStatuses)),
         kind: 'file',
      },
   ];

   for (const rawRelativePath of parseNullSeparated(untrackedOutput)) {
      const relativePath = normalizeArchiveRelativePath(rawRelativePath);
      const filePath = path.join(repoRoot, ...relativePath.split('/'));
      const fileData = fs.readFileSync(filePath);
      entries.push({
         path: `worktree/untracked/${relativePath}`,
         data: toUint8Array(fileData),
         kind: 'file',
      });
   }

   return await finalizeSnapshotArchive('worktree', repoInfo, entries);
}

/**
 * Creates a full snapshot archive containing the cleaned repository git directory.
 * @param git$ - Git executable path or command array.
 * @returns Snapshot creation result with hash and archive path.
 */
export async function createFullSnapshot(git$: string | string[]): Promise<CreateSnapshotResult> {
   const spinnerCtrl = spinner({ message: 'Collecting repository info...' });
   const repoInfo = await getSnapshotRepoInfo(git$);
   const repoRoot = repoInfo.repoRoot;
   const rawCommonDir = (await revParseCached(git$, ['--git-common-dir'])).trim();
   if (!rawCommonDir) {
      spinnerCtrl.stop();
      throw new Error('Unable to resolve the git common directory for this repository.');
   }

   const commonGitDir = path.isAbsolute(rawCommonDir)
      ? rawCommonDir
      : path.resolve(repoRoot, rawCommonDir);
   await ensureSnapshotDirectories();
   const stageRoot = fs.mkdtempSync(path.join(getSnapshotTmpDirPath(), 'full-'));
   const stageGitDir = path.join(stageRoot, 'git');

   try {
      fs.cpSync(commonGitDir, stageGitDir, { recursive: true });
      spinnerCtrl.setMessage('Creating snapshot archive...');
      await cleanGitBackupDirectory(stageGitDir);

      const gitExec = getGitExec(git$);
      await $`${gitExec} --git-dir ${stageGitDir} reflog expire --expire-unreachable=now --all`;
      await $`${gitExec} --git-dir ${stageGitDir} gc --prune=now`;

      const entries = await collectDirectorySnapshotEntries(stageGitDir, 'full/git');
      spinnerCtrl.setMessage('Finalizing snapshot...');
      return await finalizeSnapshotArchive('full', repoInfo, entries);
   } finally {
      spinnerCtrl.stop();
      fs.rmSync(stageRoot, { recursive: true, force: true });
   }
}

/**
 * Lists all known snapshots, optionally filtered to the current repository identity.
 * @param git$ - Git executable path or command array.
 * @returns Sorted snapshot list entries.
 */
export async function listSnapshots(git$: string | string[]): Promise<SnapshotListEntry[]> {
   const [currentRepo, entries] = await Promise.all([
      getCurrentRepoInfo(git$),
      rebuildSnapshotIndex(),
   ]);

   if (!currentRepo) {
      return entries;
   }

   return entries.filter((entry) => isSameRepository(entry.meta, currentRepo));
}

/**
 * Resolves and applies a snapshot by hash prefix.
 * @param git$ - Git executable path or command array.
 * @param hashPrefix - Full or short snapshot hash prefix.
 * @param force - Whether to allow destructive apply actions.
 * @returns The applied snapshot entry.
 */
export async function applySnapshot(
   git$: string | string[],
   hashPrefix: string,
   force = false
): Promise<SnapshotListEntry> {
   const snapshot = await resolveSnapshotByPrefix(hashPrefix);
   const loaded = await loadSnapshotArchive(snapshot.archivePath);

   if (loaded.meta.type === 'worktree') {
      await applyWorktreeSnapshot(git$, loaded, force);
   } else {
      await applyFullSnapshot(git$, loaded, force);
   }

   return snapshot;
}

/**
 * Imports a snapshot archive into the local snapshot object store.
 * @param snapshotPath - Path to a .gdxsnap archive.
 * @returns Imported snapshot index entry.
 */
export async function importSnapshot(snapshotPath: string): Promise<SnapshotListEntry> {
   const sourcePath = path.resolve(snapshotPath);
   if (!sourcePath.endsWith(SNAP_FILE_EXTENSION)) {
      throw new Error(`Snapshot file must use the ${SNAP_FILE_EXTENSION} extension.`);
   }

   if (!fs.existsSync(sourcePath)) {
      throw new Error(`Snapshot file '${snapshotPath}' does not exist.`);
   }

   const sourceStat = await fs.stat(sourcePath);
   if (!sourceStat.isFile()) {
      throw new Error(`Snapshot path '${snapshotPath}' is not a file.`);
   }

   const loaded = await loadSnapshotArchive(sourcePath);
   const hash = buildLoadedSnapshotHash(loaded);
   const archivePath = path.join(getSnapshotObjectsDirPath(), `${hash}${SNAP_FILE_EXTENSION}`);

   await ensureSnapshotDirectories();
   if (fs.normalizeSync(sourcePath) !== fs.normalizeSync(archivePath)) {
      await fs.cp(sourcePath, archivePath);
   }

   const entries = await rebuildSnapshotIndex();
   const imported = entries.find((entry) => entry.hash === hash);
   if (!imported) {
      throw new Error(`Imported snapshot '${snapshotPath}' could not be indexed.`);
   }

   return imported;
}

/**
 * Exports a stored snapshot archive to a directory or explicit .gdxsnap file path.
 * @param hashPrefix - Full or short snapshot hash prefix.
 * @param destination - Directory path or destination file path ending with .gdxsnap.
 * @returns The exported file path and snapshot entry.
 */
export async function exportSnapshot(
   hashPrefix: string,
   destination: string
): Promise<{ snapshot: SnapshotListEntry; destinationPath: string }> {
   if (!destination.trim()) {
      throw new Error('Missing export destination. Usage: gdx snap export <hash> <dest>.');
   }

   const snapshot = await resolveSnapshotByPrefix(hashPrefix);
   const resolvedDestination = path.resolve(destination);
   const defaultExportFileName = `${snapshot.meta.repoLabel}-${snapshot.hash.slice(0, SNAP_SHORT_HASH_LENGTH)}${SNAP_FILE_EXTENSION}`;
   const destinationPath = resolvedDestination.endsWith(SNAP_FILE_EXTENSION)
      ? resolvedDestination
      : path.join(resolvedDestination, defaultExportFileName);
   const destinationDir = path.dirname(destinationPath);

   if (!fs.existsSync(destinationDir)) {
      await fs.mkdir(destinationDir, { recursive: true });
   }

   await fs.cp(snapshot.archivePath, destinationPath);
   return {
      snapshot,
      destinationPath,
   };
}

/**
 * Returns the snapshot storage directory path.
 * @returns Snapshot root directory.
 */
export function getSnapshotRootDir(): string {
   return getSnapshotRootPath();
}

async function finalizeSnapshotArchive(
   type: SnapshotType,
   repoInfo: SnapshotRepoInfo,
   entries: SnapshotEntry[]
): Promise<CreateSnapshotResult> {
   await ensureSnapshotDirectories();

   const createdAt = new Date().toISOString();
   const metadata: SnapMetadata = {
      version: SNAP_VERSION,
      type,
      createdAt,
      repoRoot: repoInfo.repoRoot,
      repoLabel: repoInfo.repoLabel,
      repoIdentity: repoInfo.repoIdentity,
      rootCommit: repoInfo.rootCommit,
      headCommit: repoInfo.headCommit,
      headRef: repoInfo.headRef,
      branchName: repoInfo.branchName,
      originUrl: repoInfo.originUrl,
   };
   const hash = buildSnapshotHash(repoInfo, type, entries);
   const archivePath = path.join(getSnapshotObjectsDirPath(), `${hash}${SNAP_FILE_EXTENSION}`);
   const existedBefore = fs.existsSync(archivePath);

   if (!existedBefore) {
      await writeSnapshotArchive(archivePath, metadata, entries);
   }

   const indexedEntries = await rebuildSnapshotIndex();
   const persisted = indexedEntries.find((entry) => entry.hash === hash);
   return {
      hash,
      archivePath,
      existed: existedBefore,
      meta: persisted?.meta || metadata,
   };
}

function buildSnapshotHash(
   repoInfo: SnapshotRepoInfo,
   type: SnapshotType,
   entries: SnapshotEntry[]
): string {
   const canonicalMeta: SnapshotCanonicalMetadata = {
      version: SNAP_VERSION,
      type,
      repoRoot: repoInfo.repoRoot,
      repoLabel: repoInfo.repoLabel,
      repoIdentity: repoInfo.repoIdentity,
      rootCommit: repoInfo.rootCommit,
      headCommit: repoInfo.headCommit,
      headRef: repoInfo.headRef,
      branchName: repoInfo.branchName,
      originUrl: repoInfo.originUrl,
   };
   const hash = crypto.createHash('sha256');
   const encoder = new TextEncoder();
   hash.update(encoder.encode('gdxsnap/v1\0'));
   hash.update(encoder.encode(stableStringify(canonicalMeta)));

   for (const entry of sortSnapshotEntries(entries)) {
      hash.update(encoder.encode(`\0${entry.kind}\0${entry.path}\0${entry.data.length}\0`));
      hash.update(entry.data);
   }

   return hash.digest('hex').slice(0, SNAP_HASH_LENGTH);
}

/**
 * Recomputes the canonical snapshot hash for an archive loaded from any file name.
 * @param snapshot - Loaded snapshot archive.
 * @returns Canonical snapshot hash.
 */
function buildLoadedSnapshotHash(snapshot: LoadedSnapshot): string {
   const entries: SnapshotEntry[] = [];

   for (const [entryPath, data] of snapshot.entries.entries()) {
      if (entryPath === SNAP_META_FILE_NAME) {
         continue;
      }

      entries.push({
         path: entryPath,
         data,
         kind: 'file',
      });
   }

   return buildSnapshotHash(snapshot.meta, snapshot.meta.type, entries);
}

async function writeSnapshotArchive(
   archivePath: string,
   metadata: SnapMetadata,
   entries: SnapshotEntry[]
): Promise<void> {
   const fflate = await loadFflate();
   const archiveEntries: Record<string, Uint8Array> = {
      [SNAP_META_FILE_NAME]: fflate.strToU8(stableStringify(metadata)),
   };

   for (const entry of sortSnapshotEntries(entries)) {
      archiveEntries[entry.path] = entry.data;
   }

   const archiveBytes = fflate.zipSync(archiveEntries, { level: 9 as const });
   await fs.writeFile(archivePath, Buffer.from(archiveBytes));
}

async function resolveSnapshotByPrefix(hashPrefix: string): Promise<SnapshotListEntry> {
   const normalizedPrefix = hashPrefix.trim().toLowerCase();
   if (!normalizedPrefix) {
      throw new Error('Missing snapshot hash. Usage: gdx snap apply <hash>.');
   }

   const entries = await rebuildSnapshotIndex();
   const matches = entries.filter((entry) => entry.hash.startsWith(normalizedPrefix));

   if (matches.length === 0) {
      throw new Error(`No snapshot found for hash prefix '${hashPrefix}'.`);
   }

   if (matches.length > 1) {
      const candidates = matches.map((entry) => entry.hash.slice(0, SNAP_SHORT_HASH_LENGTH)).join(', ');
      throw new Error(`Snapshot hash prefix '${hashPrefix}' is ambiguous: ${candidates}.`);
   }

   return matches[0];
}

async function loadSnapshotArchive(archivePath: string): Promise<LoadedSnapshot> {
   const [fflate, archiveBytes] = await Promise.all([loadFflate(), fs.readFile(archivePath)]);
   const extracted = fflate.unzipSync(toUint8Array(archiveBytes));
   const metaEntry = extracted[SNAP_META_FILE_NAME];

   if (!metaEntry) {
      throw new Error(`Snapshot archive '${archivePath}' is missing ${SNAP_META_FILE_NAME}.`);
   }

   const meta = JSON.parse(fflate.strFromU8(metaEntry)) as SnapMetadata;
   const entries = new Map<string, Uint8Array>();

   for (const [entryPath, data] of Object.entries(extracted)) {
      entries.set(entryPath, data);
   }

   return {
      archivePath,
      hash: path.basename(archivePath, SNAP_FILE_EXTENSION),
      meta,
      entries,
   };
}

async function applyWorktreeSnapshot(
   git$: string | string[],
   snapshot: LoadedSnapshot,
   force: boolean
): Promise<void> {
   const currentRepo = await getCurrentRepoInfo(git$);
   if (!currentRepo) {
      throw new Error('Worktree snapshots can only be applied inside a compatible git repository.');
   }

   if (!isSameRepository(snapshot.meta, currentRepo)) {
      throw new Error('This worktree snapshot belongs to a different repository or root commit.');
   }

   const targetCommit = (
      await revParseCached(git$, ['--verify', `${snapshot.meta.headCommit}^{commit}`])
   ).trim();
   if (!targetCommit) {
      throw new Error('The commit referenced by this worktree snapshot is no longer available.');
   }

   if (!force && (await isDirtyWorktree(git$))) {
      throw new Error('Working tree is dirty. Re-run with --force to apply this snapshot.');
   }

   if (force) {
      await $`${git$} reset --hard HEAD`;
      await $`${git$} clean -fd`;
   }

   if (snapshot.meta.branchName && snapshot.meta.headRef) {
      await $`${git$} checkout -B ${snapshot.meta.branchName} ${snapshot.meta.headCommit}`;
   } else {
      await $`${git$} checkout --detach ${snapshot.meta.headCommit}`;
   }

   await $`${git$} reset --hard ${snapshot.meta.headCommit}`;
   await $`${git$} clean -fd`;

   await ensureSnapshotDirectories();
   const patchRoot = await fs.mkdtemp(path.join(getSnapshotTmpDirPath(), 'apply-worktree-'));

   try {
      const stagedPatch = snapshot.entries.get('worktree/staged.patch');
      const stagedStatusEntry = snapshot.entries.get('worktree/staged-status.json');
      const unstagedPatch = snapshot.entries.get('worktree/unstaged.patch');
      const stagedPatchPath = path.join(patchRoot, 'staged.patch');
      const unstagedPatchPath = path.join(patchRoot, 'unstaged.patch');
      const stagedStatuses = stagedStatusEntry
         ? (JSON.parse(new TextDecoder().decode(stagedStatusEntry)) as SnapshotPathStatus[])
         : [];

      if (stagedPatch && stagedPatch.length > 0) {
         await fs.writeFile(stagedPatchPath, Buffer.from(stagedPatch));
         await $`${git$} apply --cached --binary --whitespace=nowarn ${stagedPatchPath}`;

         for (const entry of stagedStatuses) {
            const targetPath = path.join(currentRepo.repoRoot, ...entry.path.split('/'));
            if (entry.status === 'D') {
               await fs.rm(targetPath, { force: true, recursive: true });
               continue;
            }

            if ((entry.status === 'R' || entry.status === 'C') && entry.oldPath) {
               const oldPath = path.join(currentRepo.repoRoot, ...entry.oldPath.split('/'));
               await fs.rm(oldPath, { force: true, recursive: true });
            }

            await $`${git$} checkout -- ${entry.path}`;
         }
      }

      if (unstagedPatch && unstagedPatch.length > 0) {
         await fs.writeFile(unstagedPatchPath, Buffer.from(unstagedPatch));
         await $`${git$} apply --binary --whitespace=nowarn ${unstagedPatchPath}`;
      }

      for (const [entryPath, data] of snapshot.entries.entries()) {
         if (!entryPath.startsWith('worktree/untracked/')) continue;
         const relativePath = entryPath.slice('worktree/untracked/'.length);
         const safePath = validateSnapshotRelativePath(relativePath);
         const destination = path.join(currentRepo.repoRoot, ...safePath.split('/'));
         const destinationDir = path.dirname(destination);
         if (!fs.existsSync(destinationDir)) {
            fs.mkdirSync(destinationDir, { recursive: true });
         }
         fs.writeFileSync(destination, Buffer.from(data));
      }
   } finally {
      fs.rmSync(patchRoot, { recursive: true, force: true });
   }
}

async function applyFullSnapshot(
   git$: string | string[],
   snapshot: LoadedSnapshot,
   force: boolean
): Promise<void> {
   const currentRepo = await getCurrentRepoInfo(git$);

   if (currentRepo) {
      if (!isSameRepository(snapshot.meta, currentRepo)) {
         throw new Error('This full snapshot belongs to a different repository or root commit.');
      }

      if (!force) {
         throw new Error('Applying a full snapshot inside an existing repository requires --force.');
      }

      const rawCommonDir = (await revParseCached(git$, ['--git-common-dir'])).trim();
      if (!rawCommonDir) {
         throw new Error('Unable to resolve the current repository git common directory.');
      }

      const repoRoot = currentRepo.repoRoot;
      const commonGitDir = path.isAbsolute(rawCommonDir)
         ? rawCommonDir
         : path.resolve(repoRoot, rawCommonDir);
      await ensureSnapshotDirectories();
      const restoreRoot = await fs.mkdtemp(path.join(getSnapshotTmpDirPath(), 'apply-full-'));
      const extractedGitDir = path.join(restoreRoot, '.git');
      const backupPath = `${commonGitDir}.gdx-snap-backup-${Date.now()}`;

      try {
         await extractFullGitDirectory(snapshot, extractedGitDir);

         if (fs.existsSync(backupPath)) {
            await fs.rm(backupPath, { recursive: true, force: true });
         }

         await fs.rename(commonGitDir, backupPath);

         try {
            await fs.rename(extractedGitDir, commonGitDir);
         } catch (err) {
            await fs.rename(backupPath, commonGitDir);
            throw err;
         }

         await $`${git$} reset --hard HEAD`;
         await $`${git$} clean -fd`;
         await fs.rm(backupPath, { recursive: true, force: true });
      } finally {
         await fs.rm(restoreRoot, { recursive: true, force: true });
      }

      return;
   }

   const parentDir = getGitCommandDirectory(git$);
   const targetDir = path.join(parentDir, snapshot.meta.repoLabel);
   if (fs.existsSync(targetDir)) {
      if (!force) {
         throw new Error(`Target directory '${targetDir}' already exists. Use --force to replace it.`);
      }
      await fs.rm(targetDir, { recursive: true, force: true });
   }

   fs.mkdirSync(targetDir, { recursive: true });

   const gitDirPath = path.join(targetDir, '.git');

   await extractFullGitDirectory(snapshot, gitDirPath);

   const gitExec = getGitExec(git$);
   await $`${gitExec} -C ${targetDir} reset --hard HEAD`;
   await $`${gitExec} -C ${targetDir} clean -fd`;
}

async function extractFullGitDirectory(snapshot: LoadedSnapshot, destination: string): Promise<void> {
   let extractedCount = 0;

   for (const [entryPath, data] of snapshot.entries.entries()) {
      if (!entryPath.startsWith('full/git/')) continue;
      const relativePath = entryPath.slice('full/git/'.length);
      const safePath = validateSnapshotRelativePath(relativePath);
      const destinationPath = path.join(destination, ...safePath.split('/'));
      const destinationDir = path.dirname(destinationPath);

      if (!fs.existsSync(destinationDir)) {
         fs.mkdirSync(destinationDir, { recursive: true });
      }

      await fs.writeFile(destinationPath, Buffer.from(data));
      extractedCount += 1;
   }

   if (extractedCount === 0) {
      throw new Error('Snapshot archive does not contain any full git backup entries.');
   }

   for (const relativeDir of [
      'branches',
      'hooks',
      'info',
      'objects',
      'objects/info',
      'objects/pack',
      'refs',
      'refs/heads',
      'refs/remotes',
      'refs/tags',
      'logs',
      'logs/refs',
      'logs/refs/heads',
      'logs/refs/remotes',
   ]) {
      const dirPath = path.join(destination, ...relativeDir.split('/'));
      if (!fs.existsSync(dirPath)) {
         fs.mkdirSync(dirPath, { recursive: true });
      }
   }
}

async function rebuildSnapshotIndex(): Promise<SnapshotListEntry[]> {
   await ensureSnapshotDirectories();
   const entries = await loadAllSnapshots();
   await fs.writeFile(getSnapshotIndexPath(), stableStringify(entries), 'utf-8');
   return entries;
}

async function loadAllSnapshots(): Promise<SnapshotListEntry[]> {
   const objectsDir = getSnapshotObjectsDirPath();
   if (!fs.existsSync(objectsDir)) {
      return [];
   }

   const files = (await fs.readdir(objectsDir))
      .filter((file) => file.endsWith(SNAP_FILE_EXTENSION))
      .sort((a, b) => a.localeCompare(b));
   const snapshots = await Promise.all(files.map(async (fileName) => {
      const archivePath = path.join(objectsDir, fileName);
      const loaded = await loadSnapshotArchive(archivePath);
      return {
         hash: loaded.hash,
         archivePath,
         meta: loaded.meta,
      };
   }));

   return snapshots.sort(
      (a, b) => Date.parse(b.meta.createdAt) - Date.parse(a.meta.createdAt) || a.hash.localeCompare(b.hash)
   );
}

async function getSnapshotRepoInfo(git$: string | string[]): Promise<SnapshotRepoInfo> {
   const repoRootPromise = getRepoRootCached(git$);
   const [repoRoot, rootCommitRaw, headCommitRaw, headRef, branchNameRaw, originUrlRaw] = await Promise.all([
      repoRootPromise,
      runGitStdout(git$, ['rev-list', '--max-parents=0', 'HEAD']),
      revParseCached(git$, ['HEAD']),
      runGitStdout(git$, ['symbolic-ref', '-q', 'HEAD'])
         .then((output) => output.trim() || null)
         .catch(() => null),
      revParseCached(git$, ['--abbrev-ref', 'HEAD']),
      repoRootPromise.then((repoRoot) =>
         getGitConfigValue(git$, 'remote.origin.url', repoRoot)
      ),
   ]);

   const rootCommitOutput = rootCommitRaw.trim();
   const rootCommit = rootCommitOutput.split(/\r?\n/).filter(Boolean)[0] || '';
   const headCommit = headCommitRaw.trim();
   if (!repoRoot || !rootCommit || !headCommit) {
      throw new Error('Snapshots require a repository with at least one commit.');
   }

   const branchNameOutput = branchNameRaw.trim();
   const branchName = branchNameOutput && branchNameOutput !== 'HEAD' ? branchNameOutput : null;
   const originUrl = originUrlRaw.trim() || null;
   const repoLabel = path.basename(repoRoot);
   const repoIdentity = crypto
      .createHash('sha1')
      .update(`${rootCommit}\0${originUrl || ''}`)
      .digest('hex');

   return {
      version: SNAP_VERSION,
      type: 'worktree',
      repoRoot,
      repoLabel,
      repoIdentity,
      rootCommit,
      headCommit,
      headRef,
      branchName,
      originUrl,
   };
}

async function getCurrentRepoInfo(git$: string | string[]): Promise<SnapshotRepoInfo | null> {
   try {
      const repoRoot = (await revParseCached(git$, ['--show-toplevel'])).trim();
      if (!repoRoot) return null;
      return await getSnapshotRepoInfo(git$);
   } catch {
      return null;
   }
}

function isSameRepository(meta: SnapMetadata | SnapshotRepoInfo, repoInfo: SnapshotRepoInfo): boolean {
   if (meta.rootCommit !== repoInfo.rootCommit) {
      return false;
   }

   if (meta.originUrl && repoInfo.originUrl) {
      return meta.originUrl === repoInfo.originUrl;
   }

   return meta.repoIdentity === repoInfo.repoIdentity || meta.rootCommit === repoInfo.rootCommit;
}

async function ensureSnapshotDirectories(): Promise<void> {
   await Promise.all([
      getSnapshotRootPath(),
      getSnapshotObjectsDirPath(),
      getSnapshotTmpDirPath(),
   ].map(async (dirPath) => {
      if (!fs.existsSync(dirPath)) {
         await fs.mkdir(dirPath, { recursive: true });
      }
   }));
}

function getSnapshotRootPath(): string {
   return path.join(getDynamicTempDir(), 'gdx', 'snap');
}

function getSnapshotObjectsDirPath(): string {
   return path.join(getSnapshotRootPath(), 'objects');
}

function getSnapshotIndexPath(): string {
   return path.join(getSnapshotRootPath(), 'index.json');
}

function getSnapshotTmpDirPath(): string {
   return path.join(getSnapshotRootPath(), 'tmp');
}

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

function getDynamicCurrentDir(): string {
   return process.env.GDX_CURRENT_DIR || CURRENT_DIR || process.cwd();
}

async function collectDirectorySnapshotEntries(
   rootDir: string,
   archivePrefix: string
): Promise<SnapshotEntry[]> {
   const entries: SnapshotEntry[] = [];

   await walkDir(rootDir, async (filePath) => {
      const relativePath = normalizeArchiveRelativePath(path.relative(rootDir, filePath));
      const fileData = await fs.readFile(filePath);
      entries.push({
         path: `${archivePrefix}/${relativePath}`,
         data: toUint8Array(fileData),
         kind: 'file',
      });
   });

   return entries;
}

async function cleanGitBackupDirectory(gitDir: string): Promise<void> {
   const worktreesPath = path.join(gitDir, 'worktrees');
   if (fs.existsSync(worktreesPath)) {
      await fs.rm(worktreesPath, { recursive: true, force: true });
   }

   await walkDir(gitDir, async (filePath) => {
      const baseName = path.basename(filePath);
      if (baseName.endsWith('.lock') || baseName === 'gc.log') {
         await fs.rm(filePath, { force: true });
      }
   });
}

async function isDirtyWorktree(git$: string | string[]): Promise<boolean> {
   const statusOutput = await runGitStdout(git$, ['status', '--porcelain=v1', '--untracked-files=normal']);
   return statusOutput.trim().length > 0;
}

async function runGitStdout(git$: string | string[], args: string[]): Promise<string> {
   return (await $`${git$} ${args}`).stdout;
}

function sortSnapshotEntries(entries: SnapshotEntry[]): SnapshotEntry[] {
   return [...entries].sort((a, b) => a.path.localeCompare(b.path));
}

function normalizeArchiveRelativePath(relativePath: string): string {
   return asUnixPath(relativePath).replace(/^\.\//, '').replace(/^\/+/, '');
}

function validateSnapshotRelativePath(relativePath: string): string {
   const normalized = normalizeArchiveRelativePath(relativePath);
   if (!normalized) {
      throw new Error('Snapshot archive contains an empty path entry.');
   }

   if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(relativePath)) {
      throw new Error(`Snapshot archive contains an absolute path '${relativePath}'.`);
   }

   if (/^[A-Za-z]:([\\/]|$)/.test(relativePath)) {
      throw new Error(`Snapshot archive contains a drive-qualified path '${relativePath}'.`);
   }

   const parts = normalized.split('/');
   if (parts.some((part) => !part || part === '.' || part === '..')) {
      throw new Error(`Snapshot archive contains an unsafe path '${relativePath}'.`);
   }

   return normalized;
}

function parseNullSeparated(output: string): string[] {
   return output.split('\0').map((item) => item.trim()).filter(Boolean);
}

function normalizePatchText(output: string): string {
   if (!output) {
      return output;
   }

   return output.endsWith('\n') ? output : `${output}\n`;
}

function parseNameStatusNullSeparated(output: string): SnapshotPathStatus[] {
   const tokens = output.split('\0').filter(Boolean);
   const entries: SnapshotPathStatus[] = [];

   for (let index = 0; index < tokens.length;) {
      const statusToken = tokens[index++] || '';
      const status = statusToken[0] || '';
      if (!status) {
         continue;
      }

      if (status === 'R' || status === 'C') {
         const oldPath = tokens[index++];
         const newPath = tokens[index++];
         if (oldPath && newPath) {
            entries.push({
               status,
               oldPath: normalizeArchiveRelativePath(oldPath),
               path: normalizeArchiveRelativePath(newPath),
            });
         }
         continue;
      }

      const filePath = tokens[index++];
      if (!filePath) {
         continue;
      }

      entries.push({
         status,
         path: normalizeArchiveRelativePath(filePath),
      });
   }

   return entries;
}

function getGitExec(git$: string | string[]): string {
   return Array.isArray(git$) ? git$[0] : git$;
}

function getGitCommandDirectory(git$: string | string[]): string {
   if (!Array.isArray(git$)) {
      return getDynamicCurrentDir();
   }

   for (let i = git$.length - 2; i >= 0; i--) {
      if (git$[i] === '-C' && git$[i + 1]) {
         return path.resolve(git$[i + 1]);
      }
   }

   return getDynamicCurrentDir();
}

function toUint8Array(data: Uint8Array | Buffer): Uint8Array {
   return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function stableStringify(value: unknown): string {
   return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
   if (Array.isArray(value)) {
      return value.map((item) => sortJsonValue(item));
   }

   if (value && typeof value === 'object') {
      const sortedEntries = Object.entries(value as Record<string, unknown>)
         .sort(([left], [right]) => left.localeCompare(right))
         .map(([key, nestedValue]) => [key, sortJsonValue(nestedValue)]);
      return Object.fromEntries(sortedEntries);
   }

   return value;
}

async function loadFflate(): Promise<FflateModule> {
   if (!fflateModulePromise) {
      fflateModulePromise = import('fflate');
   }

   return await fflateModulePromise;
}
