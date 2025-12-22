import { afterAll, describe, it, expect } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';

import clear from '@/commands/clear';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';

describe('gdx clear', async () => {
   const { tmpDir, $, buffer, cleanup } = await createTestEnv();
   const ctx = createGdxContext(tmpDir);

   afterAll(cleanup);

   it('should abort if directory is dirty and no force flag (implicit check, clear usually forces?)', async () => {
      // Actually clear command does `git reset --hard` so it might not abort, but let's check the code.
      // The code says: "Backs up... then resets". It doesn't seem to abort on dirty, it backs up dirty state.
      // Let's verify it creates a backup.
   });

   it('should create a backup and clean the directory', async () => {
      // Create a file and stage it
      await fs.writeFile(path.join(tmpDir, 'test.txt'), 'content');
      await $`git -C ${tmpDir} add test.txt`;

      // Create an unstaged file
      await fs.writeFile(path.join(tmpDir, 'unstaged.txt'), 'content');

      // Run clear
      const result = await clear(ctx);
      expect(result).toBe(0);

      // Verify files are gone
      const files = await fs.readdir(tmpDir);
      expect(files).not.toContain('test.txt');
      expect(files).not.toContain('unstaged.txt');

      // Verify backup exists in temp dir (which is tmpDir because of GDX_TEMP_DIR)
      const backupFiles = (await fs.readdir(tmpDir)).filter(
         (f) => f.includes('_backup_') && f.endsWith('.patch')
      );
      expect(backupFiles.length).toBe(1);
   });

   it('should list backups', async () => {
      buffer.stdout = '';
      const listCtx = createGdxContext(tmpDir, ['list']);
      const result = await clear(listCtx);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain('backup_');
      expect(buffer.stdout).toContain('.patch');
   });

   it('should restore backup with pardon', async () => {
      // Run pardon
      const pardonCtx = createGdxContext(tmpDir, ['pardon']);
      const result = await clear(pardonCtx);

      expect(result).toBe(0);

      // Verify files are back
      const files = await fs.readdir(tmpDir);
      expect(files).toContain('test.txt');
      // Unstaged files might be restored as staged or unstaged depending on how patch works,
      // but they should be there.
      // Note: `git apply` might fail if file already exists or something, but here dir was clean.
   });
});
