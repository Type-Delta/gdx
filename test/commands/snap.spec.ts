import { describe, expect } from 'bun:test';
import path from 'path';

import * as fs from '@/modules/fs';
import { revParseCached } from '@/modules/git';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';
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

describe('gdx snap worktree', async () => {
   const { tmpDir, tmpRootDir, $, buffer, it, resetRepo } = await createTestEnv({
      suitName: 'snap-worktree',
   });
   const { default: snap } = await import('@/commands/snap');
   const { dispatch } = await import('@/cli/dispatch');
   const { git$ } = createGdxContext(tmpDir);

   async function resetState(): Promise<void> {
      await resetRepo('full');
      await fs.rm(path.join(tmpRootDir, 'tmp', 'gdx'), { recursive: true, force: true });
   }

   it('creates deterministic single-file worktree snapshots', async () => {
      await resetState();

      const firstResult = await snap(createGdxContext(tmpDir, ['snap', 'worktree']));
      expect(firstResult).toBe(0);

      const firstArchives = await listSnapshotArchives(tmpRootDir);
      expect(firstArchives.length).toBe(1);

      const secondResult = await snap(createGdxContext(tmpDir, ['snap', 'worktree']));
      expect(secondResult).toBe(0);

      const secondArchives = await listSnapshotArchives(tmpRootDir);
      expect(secondArchives).toEqual(firstArchives);
      expect(getCombinedOutput(buffer)).toContain('Reused');
   });

   it('captures staged, unstaged, untracked unicode files and restores them with --force', async () => {
      await resetState();

      await fs.writeFile(path.join(tmpDir, '.gitignore'), 'ignored.tmp\n', 'utf-8');
      await fs.writeFile(path.join(tmpDir, 'tracked.txt'), 'base\n', 'utf-8');
      await fs.writeFile(path.join(tmpDir, 'staged.txt'), 'base staged\n', 'utf-8');
      await $`${git$} add .gitignore tracked.txt staged.txt`;
      await $`${git$} commit --no-verify -m ${'Add tracked base'}`;

      const originalBranch = (await revParseCached(git$, ['--abbrev-ref', 'HEAD'])).trim();

      await fs.writeFile(path.join(tmpDir, 'tracked.txt'), 'base\nunstaged\n', 'utf-8');
      await fs.writeFile(path.join(tmpDir, 'staged.txt'), 'staged content\n', 'utf-8');
      await $`${git$} add staged.txt`;

      fs.mkdirSync(path.join(tmpDir, '目录'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'emoji-🚀.txt'), 'rocket\n', 'utf-8');
      await fs.writeFile(path.join(tmpDir, '中文文件.txt'), 'hanzi\n', 'utf-8');
      await fs.writeFile(path.join(tmpDir, 'space name.txt'), 'space\n', 'utf-8');
      await fs.writeFile(path.join(tmpDir, '目录', 'emoji-✨.txt'), 'sparkles\n', 'utf-8');
      await fs.writeFile(path.join(tmpDir, 'ignored.tmp'), 'ignored\n', 'utf-8');

      const snapshotResult = await snap(createGdxContext(tmpDir, ['snap', 'worktree']));
      expect(snapshotResult).toBe(0);

      const archives = await listSnapshotArchives(tmpRootDir);
      expect(archives.length).toBe(1);
      const snapshotHash = archives[0].replace(new RegExp(`${SNAP_FILE_EXTENSION}$`), '');
      await fs.rm(path.join(tmpDir, 'ignored.tmp'), { force: true });

      await $`${git$} checkout -b ${'feature-temp'}`;
      await $`${git$} reset --hard HEAD`;
      await $`${git$} clean -fd`;
      await fs.writeFile(path.join(tmpDir, 'dirty.txt'), 'dirty\n', 'utf-8');

      const dirtyApplyResult = await snap(
         createGdxContext(tmpDir, ['snap', 'apply', snapshotHash.slice(0, SNAP_SHORT_HASH_LENGTH)])
      );
      expect(dirtyApplyResult).toBe(1);
      expect(getCombinedOutput(buffer)).toContain('Working tree is dirty');

      const forceApplyResult = await snap(
         createGdxContext(tmpDir, [
            'snap',
            'apply',
            snapshotHash.slice(0, SNAP_SHORT_HASH_LENGTH),
            '--force',
         ])
      );
      expect(forceApplyResult).toBe(0);

      const restoredBranch = (await revParseCached(git$, ['--abbrev-ref', 'HEAD'])).trim();
      const stagedNames = (await $`${git$} diff --cached --name-only`).stdout;
      const unstagedNames = (await $`${git$} diff --name-only`).stdout;

      expect(restoredBranch).toBe(originalBranch);
      expect(stagedNames).toContain('staged.txt');
      expect(unstagedNames).toContain('tracked.txt');
      expect(await fs.readFile(path.join(tmpDir, 'tracked.txt'), 'utf-8')).toBe('base\nunstaged\n');
      expect(await fs.readFile(path.join(tmpDir, 'staged.txt'), 'utf-8')).toBe('staged content\n');
      expect(await fs.readFile(path.join(tmpDir, 'emoji-🚀.txt'), 'utf-8')).toBe('rocket\n');
      expect(await fs.readFile(path.join(tmpDir, '中文文件.txt'), 'utf-8')).toBe('hanzi\n');
      expect(await fs.readFile(path.join(tmpDir, 'space name.txt'), 'utf-8')).toBe('space\n');
      expect(await fs.readFile(path.join(tmpDir, '目录', 'emoji-✨.txt'), 'utf-8')).toBe('sparkles\n');
      expect(fs.existsSync(path.join(tmpDir, 'ignored.tmp'))).toBe(false);
   });

   it('lists snapshots through dispatch both inside and outside a repository', async () => {
      await resetState();

      await fs.writeFile(path.join(tmpDir, 'list.txt'), 'list\n', 'utf-8');
      await $`${git$} add list.txt`;
      await $`${git$} commit --no-verify -m ${'Add list file'}`;

      expect(await snap(createGdxContext(tmpDir, ['snap', 'worktree']))).toBe(0);
      expect(await snap(createGdxContext(tmpDir, ['snap', 'full']))).toBe(0);

      const insideResult = await dispatch(createGdxContext(tmpDir, ['snap', 'list']));
      expect(insideResult).toBe(0);
      expect(buffer.stdout).toContain('worktree');
      expect(buffer.stdout).toContain('full');
      expect(buffer.stdout).toContain(path.basename(tmpDir));

      const outsideDir = path.join(tmpRootDir, 'outside-list');
      fs.mkdirSync(outsideDir, { recursive: true });

      const outsideResult = await dispatch(createGdxContext(outsideDir, ['snap', 'list']));
      expect(outsideResult).toBe(0);
      expect(buffer.stdout).toContain('worktree');
      expect(buffer.stdout).toContain('full');
   });

   it('rejects ambiguous hash prefixes', async () => {
      await resetState();

      await fs.writeFile(path.join(tmpDir, 'collision.txt'), 'seed\n', 'utf-8');
      await $`${git$} add collision.txt`;
      await $`${git$} commit --no-verify -m ${'Add collision seed'}`;
      expect(await snap(createGdxContext(tmpDir, ['snap', 'worktree']))).toBe(0);

      const archives = await listSnapshotArchives(tmpRootDir);
      expect(archives.length).toBe(1);

      const originalArchive = archives[0];
      const originalHash = originalArchive.replace(new RegExp(`${SNAP_FILE_EXTENSION}$`), '');
      const ambiguousPrefix = originalHash[0];
      const duplicateHash = `${ambiguousPrefix}${originalHash[1] === 'a' ? 'b' : 'a'}${'0'.repeat(originalHash.length - 2)}`;
      const archiveDir = snapshotObjectsDir(tmpRootDir);

      await fs.cp(
         path.join(archiveDir, originalArchive),
         path.join(archiveDir, `${duplicateHash}${SNAP_FILE_EXTENSION}`)
      );

      await $`${git$} reset --hard HEAD`;
      await $`${git$} clean -fd`;

      const applyResult = await snap(
         createGdxContext(tmpDir, ['snap', 'apply', ambiguousPrefix, '--force'])
      );
      expect(applyResult).toBe(1);
      expect(getCombinedOutput(buffer).toLowerCase()).toContain('ambiguous');
   });
});
