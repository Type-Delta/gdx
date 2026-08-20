import { describe, expect } from 'bun:test';
import path from 'path';

import * as fs from '@/modules/fs';
import { dispatch } from '@/cli/dispatch';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';

interface MergeWorktreeInfo {
   alias: string;
   path: string;
   meta: {
      purpose?: string;
      targetBranch?: string;
   };
}

describe('gdx sync', async () => {
   const { tmpDir, tmpRootDir, $, buffer, it, resetRepo } = await createTestEnv({
      autoResetBuffer: true,
      suitName: 'sync',
   });
   const { git$ } = createGdxContext(tmpDir);

   const remotePath = path.join(tmpRootDir, 'sync-remote.git');
   const peerPath = path.join(tmpRootDir, 'sync-peer');

   async function resetFixture(): Promise<void> {
      await resetRepo('full');
      await fs.rm(remotePath, { recursive: true, force: true });
      await fs.rm(peerPath, { recursive: true, force: true });
      await fs.rm(path.join(tmpRootDir, 'tmp', 'worktrees'), {
         recursive: true,
         force: true,
      });
   }

   async function commitFile(
      repoPath: string,
      fileName: string,
      content: string,
      message: string
   ): Promise<void> {
      fs.writeFileSync(path.join(repoPath, fileName), content);
      await $`${git$} -C ${repoPath} add ${fileName}`;
      await $`${git$} -C ${repoPath} commit --no-verify -m ${message}`;
   }

   async function createRemoteFixture(): Promise<void> {
      await $`${git$} init --bare ${remotePath}`;
      await $`${git$} remote add origin ${remotePath}`;
      await commitFile(tmpDir, 'shared.txt', 'base\n', 'Add shared fixture');
      await $`${git$} push --set-upstream origin master`;
      await $`${git$} config pull.rebase false`;

      await $`${git$} clone ${remotePath} ${peerPath}`;
      await $`${git$} -C ${peerPath} config user.name ${'Peer User'}`;
      await $`${git$} -C ${peerPath} config user.email ${'peer@example.com'}`;
   }

   function readMergeWorktrees(): MergeWorktreeInfo[] {
      const worktreeRoot = path.join(tmpRootDir, 'tmp', 'worktrees');
      if (!fs.existsSync(worktreeRoot)) return [];

      const result: MergeWorktreeInfo[] = [];
      const visit = (dir: string): void => {
         for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const child = path.join(dir, entry.name);
            if (!entry.isDirectory()) continue;

            const metaPath = path.join(child, '.git-parallel.json');
            if (fs.existsSync(metaPath)) {
               const meta = JSON.parse(
                  fs.readFileSync(metaPath, 'utf-8')
               ) as MergeWorktreeInfo['meta'];
               if (meta.purpose === 'merge-target') {
                  result.push({ alias: entry.name, path: child, meta });
               }
               continue;
            }

            visit(child);
         }
      };

      visit(worktreeRoot);
      return result;
   }

   it('pulls before pushing and publishes both local and peer changes', async () => {
      await resetFixture();
      await createRemoteFixture();

      await commitFile(tmpDir, 'local.txt', 'local\n', 'Add local change');
      await commitFile(peerPath, 'peer.txt', 'peer\n', 'Add peer change');
      await $`${git$} -C ${peerPath} push origin master`;

      const result = await dispatch(createGdxContext(tmpDir, ['sync']));
      const remoteFiles = (await $`${git$} --git-dir ${remotePath} ls-tree -r --name-only master`)
         .stdout;
      const localFiles = (await $`${git$} ls-tree -r --name-only HEAD`).stdout;

      expect(result).toBe(0);
      expect(remoteFiles).toContain('local.txt');
      expect(remoteFiles).toContain('peer.txt');
      expect(localFiles).toContain('local.txt');
      expect(localFiles).toContain('peer.txt');
   });

   it('does not push when pulling fails', async () => {
      await resetFixture();
      await createRemoteFixture();

      await commitFile(tmpDir, 'local.txt', 'local\n', 'Add local change');
      await commitFile(peerPath, 'shared.txt', 'peer\n', 'Change shared remotely');
      await $`${git$} -C ${peerPath} push origin master`;

      fs.writeFileSync(path.join(tmpDir, 'shared.txt'), 'uncommitted local\n');
      const result = await dispatch(createGdxContext(tmpDir, ['sync']));
      const remoteFiles = (await $`${git$} --git-dir ${remotePath} ls-tree -r --name-only master`)
         .stdout;
      const remoteHead = (
         await $`${git$} --git-dir ${remotePath} rev-parse refs/heads/master`
      ).stdout.trim();
      const peerHead = (await $`${git$} -C ${peerPath} rev-parse HEAD`).stdout.trim();

      expect(result).not.toBe(0);
      expect(remoteFiles).not.toContain('local.txt');
      expect(remoteHead).toBe(peerHead);
      expect(fs.readFileSync(path.join(tmpDir, 'shared.txt'), 'utf-8')).toBe('uncommitted local\n');
   });

   it('syncs a target branch against and back to its own upstream', async () => {
      await resetFixture();
      await createRemoteFixture();

      await $`${git$} branch target`;
      await $`${git$} switch target`;
      await $`${git$} push --set-upstream origin target`;
      await $`${git$} switch master`;

      await commitFile(tmpDir, 'current-only.txt', 'current\n', 'Add current branch change');
      await $`${git$} switch target`;
      await commitFile(tmpDir, 'target-local.txt', 'target local\n', 'Add local target change');
      await $`${git$} switch master`;
      await $`${git$} -C ${peerPath} fetch origin target`;
      await $`${git$} -C ${peerPath} switch --track -c target origin/target`;
      await commitFile(peerPath, 'target-peer.txt', 'target peer\n', 'Add peer target change');
      await $`${git$} -C ${peerPath} push origin target`;

      const result = await dispatch(createGdxContext(tmpDir, ['sync', '--target', 'target']));
      const remoteFiles = (await $`${git$} --git-dir ${remotePath} ls-tree -r --name-only target`)
         .stdout;
      const remoteCurrentFiles = (
         await $`${git$} --git-dir ${remotePath} ls-tree -r --name-only master`
      ).stdout;
      const currentFiles = (await $`${git$} ls-tree -r --name-only master`).stdout;

      expect(result).toBe(0);
      expect(remoteFiles).toContain('target-local.txt');
      expect(remoteFiles).toContain('target-peer.txt');
      expect(remoteFiles).not.toContain('current-only.txt');
      expect(remoteCurrentFiles).not.toContain('current-only.txt');
      expect(currentFiles).toContain('current-only.txt');
   });

   it('uses a merge-target worktree and preserves conflict guidance for target upstreams', async () => {
      await resetFixture();
      await createRemoteFixture();

      await $`${git$} branch target`;
      await $`${git$} switch target`;
      await $`${git$} push --set-upstream origin target`;
      await commitFile(tmpDir, 'shared.txt', 'target\n', 'Change shared on target');
      await $`${git$} switch master`;

      await $`${git$} -C ${peerPath} fetch origin target`;
      await $`${git$} -C ${peerPath} switch --track -c target origin/target`;
      await commitFile(peerPath, 'shared.txt', 'peer\n', 'Change shared on target upstream');
      await $`${git$} -C ${peerPath} push origin target`;
      const targetRemoteBefore = (
         await $`${git$} --git-dir ${remotePath} rev-parse refs/heads/target`
      ).stdout.trim();

      const result = await dispatch(createGdxContext(tmpDir, ['sync', '--target', 'target']));
      const mergeWorktrees = readMergeWorktrees();
      const targetRemoteAfter = (
         await $`${git$} --git-dir ${remotePath} rev-parse refs/heads/target`
      ).stdout.trim();

      expect(result).toBe(1);
      expect(targetRemoteAfter).toBe(targetRemoteBefore);
      expect(mergeWorktrees).toHaveLength(1);
      expect(mergeWorktrees[0].meta.purpose).toBe('merge-target');
      expect(mergeWorktrees[0].meta.targetBranch).toBe('target');
      expect(buffer.stdout).toContain('merge --continue');
   });
});
