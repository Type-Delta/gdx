import { afterAll, describe, expect } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';

import clear from '@/commands/clear';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';

describe('gdx clear', async () => {
   const { tmpDir, tmpRootDir, $, buffer, cleanup, it } = await createTestEnv();
   const { git$ } = createGdxContext(tmpDir);
   afterAll(cleanup);

   it('should create a backup containing untracked files and clean the directory', async () => {
      // Create a file and stage it
      await fs.writeFile(path.join(tmpDir, 'staged.txt'), 'staged content');
      await $`${git$} add staged.txt`;

      // Create an untracked file
      await fs.writeFile(path.join(tmpDir, 'untracked.txt'), 'untracked content');

      const ctx = createGdxContext(tmpDir);
      const result = await clear(ctx);

      expect(result).toBe(0);
      expect(buffer.stdout).toContain('Backup of all changes saved to');

      // Verify files are gone form workspace
      const files = await fs.readdir(tmpDir);
      expect(files).not.toContain('staged.txt');
      expect(files).not.toContain('untracked.txt');

      // Verify backup exists in temp dir
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
      expect(buffer.stdout).toContain('Pardon applied successfully');

      // Verify files are back
      const files = await fs.readdir(tmpDir);

      // Verify files are restored
      expect(files).toContain('staged.txt');
      expect(files).toContain('untracked.txt');

      // Verify content
      const content = await fs.readFile(path.join(tmpDir, 'untracked.txt'), 'utf-8');
      expect(content).toBe('untracked content');
   });
});
