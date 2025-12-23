import { afterAll, describe, expect } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';

import clear from '@/commands/clear';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';

describe('gdx clear', async () => {
   const { tmpDir, tmpRootDir, $, buffer, cleanup, it } = await createTestEnv();
   afterAll(cleanup);

   it('should abort if directory containts untrack file', async () => {
      // Create a file and stage it (dirty state)
      await fs.writeFile(path.join(tmpDir, 'test.txt'), 'content');
      await $`git -C ${tmpDir} add test.txt`;

      // Create an unstaged file (this file should prevent clear without --force)
      await fs.writeFile(path.join(tmpDir, 'unstaged.txt'), 'content');

      const ctx = createGdxContext(tmpDir);
      const result = await clear(ctx);
      expect(result).toBe(1);
      // LINK: mmhrb3j string literal in spec
      expect(buffer.stdout.toLocaleLowerCase()).toContain('clear aborted');

      // Verify files are still there
      const files = await fs.readdir(tmpDir);
      expect(files).toContain('test.txt');
      expect(files).toContain('unstaged.txt');
   });

   it('should create a backup and clean the directory', async () => {
      // from previous test, we have staged and unstaged files

      // Run clear
      const forceCtx = createGdxContext(tmpDir, ['--force']); // we need --force to override abort
      const result = await clear(forceCtx);
      expect(result).toBe(0);

      // Verify files are gone
      const files = await fs.readdir(tmpDir);
      expect(files).not.toContain('test.txt');
      expect(files).not.toContain('unstaged.txt');

      // Verify backup exists in temp dir (which is tmpDir/tmp because of mock)
      const backupDir = path.join(tmpRootDir, 'tmp');
      const backupFiles = (await fs.readdir(backupDir)).filter(
         (f) => f.includes('_backup_') && f.endsWith('.patch')
      );
      expect(backupFiles.length).toBe(1);
   });

   it('should list backups', async () => {
      const listCtx = createGdxContext(tmpDir, ['clear', 'list']);
      const result = await clear(listCtx);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain('backup_');
      expect(buffer.stdout).toContain('.patch');
   });

   it('should restore backup with pardon', async () => {
      // Run pardon
      const pardonCtx = createGdxContext(tmpDir, ['clear', 'pardon']);
      const result = await clear(pardonCtx);

      expect(result).toBe(0);

      // Verify files are back
      const files = await fs.readdir(tmpDir);
      expect(files).toContain('test.txt');
   });
});
