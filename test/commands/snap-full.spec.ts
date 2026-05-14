import { describe, expect } from 'bun:test';
import path from 'path';

import * as fs from '@/modules/fs';
import { createGdxContext, createTestEnv, setTestGitConfig } from '@/utils/testHelper';
import { SNAP_FILE_EXTENSION, SNAP_SHORT_HASH_LENGTH } from '@/consts';

function snapshotObjectsDir(tmpRootDir: string): string {
   return path.join(tmpRootDir, 'tmp', 'gdx', 'snap', 'objects');
}

async function listSnapshotArchives(tmpRootDir: string): Promise<string[]> {
   const dirPath = snapshotObjectsDir(tmpRootDir);
   if (!fs.existsSync(dirPath)) {
      return [];
   }

   return (await fs.readdir(dirPath))
      .filter((fileName) => fileName.endsWith(SNAP_FILE_EXTENSION))
      .sort((a, b) => a.localeCompare(b));
}

function getCombinedOutput(buffer: { stdout: string; stderr: string; logs: string }): string {
   return `${buffer.stdout}\n${buffer.stderr}\n${buffer.logs}`;
}

describe('gdx snap full', async () => {
   const { tmpDir, tmpRootDir, $, buffer, it, resetRepo } = await createTestEnv({
      suitName: 'snap-full',
   });
   const { default: snap } = await import('@/commands/snap');
   const { git$ } = createGdxContext(tmpDir);

   async function resetState(): Promise<void> {
      await resetRepo('full');
      await fs.rm(path.join(tmpRootDir, 'tmp', 'gdx'), { recursive: true, force: true });
   }

   it('creates a single-file full snapshot and restores it into a non-repo directory', async () => {
      await resetState();

      await fs.writeFile(path.join(tmpDir, 'full.txt'), 'full restore\n', 'utf-8');
      await $`${git$} add full.txt`;
      await $`${git$} commit --no-verify -m ${'Add full restore file'}`;
      const originalHead = (await $`${git$} rev-parse HEAD`).stdout.trim();

      const snapshotResult = await snap(createGdxContext(tmpDir, ['snap', 'full']));
      expect(snapshotResult).toBe(0);

      const archives = await listSnapshotArchives(tmpRootDir);
      expect(archives.length).toBe(1);
      const snapshotHash = archives[0].replace(new RegExp(`${SNAP_FILE_EXTENSION}$`), '');

      const tempBase = process.env.TEMP || process.env.TMP || tmpRootDir;
      const restoreDir = await fs.mkdtemp(path.join(tempBase, 'gdx-snap-full-restore-'));

      const restoreResult = await snap(
         createGdxContext(restoreDir, ['snap', 'apply', snapshotHash.slice(0, SNAP_SHORT_HASH_LENGTH)])
      );
      expect(restoreResult).toBe(0);

      expect(fs.existsSync(path.join(restoreDir, '.git'))).toBe(true);
      expect(await fs.readFile(path.join(restoreDir, 'full.txt'), 'utf-8')).toBe('full restore\n');

      const gitExec = Array.isArray(git$) ? git$[0] : git$;
      const restoredHead = (await $`${gitExec} -C ${restoreDir} rev-parse HEAD`).stdout.trim();
      const restoredStatus = (await $`${gitExec} -C ${restoreDir} status --porcelain=v1`).stdout.trim();

      expect(restoredHead).toBe(originalHead);
      expect(restoredStatus).toBe('');
   });

   it('rejects applying a snapshot into a different root history', async () => {
      await resetState();

      await fs.writeFile(path.join(tmpDir, 'source.txt'), 'source\n', 'utf-8');
      await $`${git$} add source.txt`;
      await $`${git$} commit --no-verify -m ${'Add source snapshot file'}`;

      expect(await snap(createGdxContext(tmpDir, ['snap', 'worktree']))).toBe(0);
      const archives = await listSnapshotArchives(tmpRootDir);
      expect(archives.length).toBe(1);
      const snapshotHash = archives[0].replace(new RegExp(`${SNAP_FILE_EXTENSION}$`), '');

      const gitExec = Array.isArray(git$) ? git$[0] : git$;
      const otherRepo = path.join(tmpRootDir, 'other-project');
      fs.mkdirSync(otherRepo, { recursive: true });
      await $`${gitExec} -C ${otherRepo} init`;
      await setTestGitConfig(otherRepo, 'user.name', 'Other User');
      await setTestGitConfig(otherRepo, 'user.email', 'other@example.com');
      await fs.writeFile(path.join(otherRepo, 'other.txt'), 'other\n', 'utf-8');
      await $`${gitExec} -C ${otherRepo} add other.txt`;
      await $`${gitExec} -C ${otherRepo} commit --no-verify -m ${'Other root commit'}`;

      const applyResult = await snap(
         createGdxContext(otherRepo, ['snap', 'apply', snapshotHash.slice(0, SNAP_SHORT_HASH_LENGTH), '--force'])
      );
      expect(applyResult).toBe(1);
      expect(getCombinedOutput(buffer)).toContain('different repository or root commit');
   });
});
