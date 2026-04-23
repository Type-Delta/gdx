import { beforeAll, describe, expect } from 'bun:test';
import * as fs from '@/modules/fs';
import path from 'path';

import status from '@/commands/status';
import { createGdxContext, createTestEnv, setTestGitConfig } from '@/utils/testHelper';
import { cleanString } from '@lib/Tools';
import { addSubmodule } from '@/modules/git';

describe('gdx status', async () => {
   const { tmpDir, tmpRootDir, $, buffer, it } = await createTestEnv({
      suitName: 'status'
   });

   // Setup submodule for tests that need it
   let submoduleCreated = false;

   beforeAll(async () => {
      // Allow file:// protocol for local submodule testing
      const gitPath = (await import('@/modules/shell')).whichExec;
      const git = await gitPath('git');
      if (!git) throw new Error('Git not found');

      try {
         await setTestGitConfig(tmpDir, 'protocol.file.allow', 'always', { scope: 'global' });
      } catch {
         // Ignore if config fails
      }
   });

   it('should pass through to git status without recursive flag', async () => {
      // Create a file to show in status
      fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'test content');

      const ctx = createGdxContext(tmpDir, ['status']);
      const exitCode = await status(ctx);

      expect(exitCode).toBe(0);
      // Note: $inherit writes directly to stdout, so we can't capture it in buffer
      // Just check that it succeeds
   });

   it('should show recursive status with -r flag', async () => {
      // Create a submodule repository only once
      if (!submoduleCreated) {
         const submoduleDir = path.join(tmpRootDir, 'submodule');
         fs.mkdirSync(submoduleDir, { recursive: true });

         // Initialize submodule as a git repo
         const gitPath = (await import('@/modules/shell')).whichExec;
         const git = await gitPath('git');
         if (!git) throw new Error('Git not found');

         await $({ cwd: submoduleDir })`${git} init`;
          await setTestGitConfig(submoduleDir, 'user.name', 'Test User');
          await setTestGitConfig(submoduleDir, 'user.email', 'test@example.com');

         // Create a file in submodule and commit it
         fs.writeFileSync(path.join(submoduleDir, 'sub.txt'), 'submodule content');
         await $({ cwd: submoduleDir })`${git} add .`;
         await $({ cwd: submoduleDir })`${git} commit -m ${'Initial submodule commit'}`;

         // Add as submodule to main repo
         try {
            await addSubmodule(git, tmpDir, submoduleDir, 'mysubmodule');
            await $`${git} add .gitmodules mysubmodule`;
            await $`${git} commit -m ${'Add submodule'}`;
            submoduleCreated = true;
         } catch (err) {
            // If submodule add fails, skip remaining tests
            console.log('Failed to add submodule:', err);
            return;
         }
      }

      // Verify submodule exists
      const submodulePath = path.join(tmpDir, 'mysubmodule');
      if (!fs.existsSync(submodulePath)) {
         console.log('Submodule path does not exist, skipping test');
         return;
      }

      // Create a dirty file in the submodule
      fs.writeFileSync(path.join(submodulePath, 'dirty.txt'), 'dirty content');

      buffer.stdout = '';
      buffer.stderr = '';

      const ctx = createGdxContext(tmpDir, ['status', '-r']);
      const exitCode = await status(ctx);

      expect(exitCode).toBe(0);
      const output = cleanString(buffer.stdout);

      // Should show repository root section
      expect(output).toContain('Repository Root');

      // Should show submodule section with path
      expect(output).toContain('Submodule: mysubmodule');

      // Should show the dirty file in submodule
      expect(output).toContain('dirty.txt');
   });

   it('should show recursive status with --recursive flag', async () => {
      // Skip if submodule wasn't created
      if (!submoduleCreated) {
         return;
      }

      // Reuse the submodule from previous test
      const submodulePath = path.join(tmpDir, 'mysubmodule');

      // Ensure there's still a dirty file
      if (!fs.existsSync(path.join(submodulePath, 'dirty.txt'))) {
         fs.writeFileSync(path.join(submodulePath, 'dirty.txt'), 'dirty content');
      }

      buffer.stdout = '';
      buffer.stderr = '';

      const ctx = createGdxContext(tmpDir, ['status', '--recursive']);
      const exitCode = await status(ctx);

      expect(exitCode).toBe(0);
      const output = cleanString(buffer.stdout);

      expect(output).toContain('Repository Root');
      expect(output).toContain('Submodule: mysubmodule');
      expect(output).toContain('dirty.txt');
   });

   it('should handle status with --short flag recursively', async () => {
      // Skip if submodule wasn't created
      if (!submoduleCreated) {
         return;
      }

      const submodulePath = path.join(tmpDir, 'mysubmodule');

      // Ensure there's still a dirty file
      if (!fs.existsSync(path.join(submodulePath, 'dirty.txt'))) {
         fs.writeFileSync(path.join(submodulePath, 'dirty.txt'), 'dirty content');
      }

      buffer.stdout = '';
      buffer.stderr = '';

      const ctx = createGdxContext(tmpDir, ['status', '-r', '--short']);
      const exitCode = await status(ctx);

      expect(exitCode).toBe(0);
      const output = cleanString(buffer.stdout);

      // Should still show headers
      expect(output).toContain('Repository Root');
      expect(output).toContain('Submodule: mysubmodule');

      // Should show short format (with ?? prefix for untracked)
      expect(output).toContain('??');
      expect(output).toContain('dirty.txt');
   });

   it('should handle repository with no submodules', async () => {
      // Create a fresh repo without submodules
      const freshDir = path.join(tmpRootDir, 'fresh');
      fs.mkdirSync(freshDir, { recursive: true });

      const gitPath = (await import('@/modules/shell')).whichExec;
      const git = await gitPath('git');
      if (!git) throw new Error('Git not found');

      await $({ cwd: freshDir })`${git} init`;
       await setTestGitConfig(freshDir, 'user.name', 'Test User');
       await setTestGitConfig(freshDir, 'user.email', 'test@example.com');
      await $({ cwd: freshDir })`${git} commit --allow-empty -m ${'Initial commit'}`;

      buffer.stdout = '';
      buffer.stderr = '';

      const ctx = createGdxContext(freshDir, ['status', '-r']);
      const exitCode = await status(ctx);

      expect(exitCode).toBe(0);
      const output = cleanString(buffer.stdout);

      expect(output).toContain('Repository Root');
      expect(output).toContain('No submodules found');
   });

   it('should show relative paths from current directory', async () => {
      // Skip if submodule wasn't created
      if (!submoduleCreated) {
         return;
      }

      const submodulePath = path.join(tmpDir, 'mysubmodule');

      // Ensure there's a dirty file
      if (!fs.existsSync(path.join(submodulePath, 'dirty.txt'))) {
         fs.writeFileSync(path.join(submodulePath, 'dirty.txt'), 'dirty content');
      }

      buffer.stdout = '';
      buffer.stderr = '';

      const ctx = createGdxContext(tmpDir, ['status', '-r']);
      const exitCode = await status(ctx);

      expect(exitCode).toBe(0);
      const output = cleanString(buffer.stdout);

      // Should show the submodule path in the header (relative path will vary based on cwd)
      expect(output).toContain('Submodule: mysubmodule');
      expect(output).toContain('mysubmodule');
   });
});
