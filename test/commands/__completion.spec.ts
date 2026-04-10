import { describe, expect } from 'bun:test';
import path from 'path';

import * as fs from '@/modules/fs';

import completion from '@/commands/__completion';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';
import global from '@/global';

describe('gdx __completion', async () => {
   const { tmpDir, tmpRootDir, buffer, it } = await createTestEnv({ suitName: '__completion' });

   it('suggests using command structure and preserves log level', async () => {
      const previous = global.logLevel;
      process.env.GDX_CMP_IDX = '2';

      const ctx = createGdxContext(tmpDir, ['__completion', 'parallel', 'fork', '--m']);
      const exitCode = await completion(ctx);

      expect(exitCode).toBe(0);
      expect(buffer.stdout).toContain('--move');
      expect(global.logLevel).toBe(previous);

      delete process.env.GDX_CMP_IDX;
   });

   it('should not suggest duplicate options', async () => {
      const previous = global.logLevel;
      process.env.GDX_CMP_IDX = '3';

      let ctx = createGdxContext(tmpDir, ['__completion', 'parallel', 'fork', '--move', '--m']);
      let exitCode = await completion(ctx);

      expect(exitCode).toBe(0);
      expect(buffer.stdout.trim()).toEqual('');
      expect(global.logLevel).toBe(previous);

      // passing incorrect index of 2 it should not suggest `--keep` again
      buffer.stdout = '';
      process.env.GDX_CMP_IDX = '2';
      ctx = createGdxContext(tmpDir, ['__completion', 'parallel', 'join', '--keep', '']);
      exitCode = await completion(ctx);

      expect(exitCode).toBe(0);
      expect(buffer.stdout.trim()).toEqual('');
      expect(global.logLevel).toBe(previous);

      delete process.env.GDX_CMP_IDX;
   });

   it('suggests multiple root-level commands', async () => {
      process.env.GDX_CMP_IDX = '0';

      const ctx = createGdxContext(tmpDir, ['__completion', 'pa']);
      const exitCode = await completion(ctx);

      expect(exitCode).toBe(0);
      // Should suggest 'parallel' (gdx custom command)
      expect(buffer.stdout).toContain('parallel');

      delete process.env.GDX_CMP_IDX;
   });

   it('suggests git commands at root level', async () => {
      process.env.GDX_CMP_IDX = '0';

      const ctx = createGdxContext(tmpDir, ['__completion', 'st']);
      const exitCode = await completion(ctx);

      expect(exitCode).toBe(0);
      // Should suggest 'stash', 'status', 'stats'
      const output = buffer.stdout;
      expect(output).toContain('stash');
      expect(output).toContain('status');
      expect(output).toContain('stats');

      delete process.env.GDX_CMP_IDX;
   });

   it('suggests shorthands at root level', async () => {
      process.env.GDX_CMP_IDX = '0';

      const ctx = createGdxContext(tmpDir, ['__completion', 'p']);
      const exitCode = await completion(ctx);

      expect(exitCode).toBe(0);
      // Should include shorthands like 'ps', 'pl', 'pu'
      const output = buffer.stdout;
      expect(output).toContain('ps');
      expect(output).toContain('pl');

      delete process.env.GDX_CMP_IDX;
   });

   it('returns empty output for unknown command (git fallback)', async () => {
      process.env.GDX_CMP_IDX = '1';

      const ctx = createGdxContext(tmpDir, ['__completion', 'checkout', 'main']);
      const exitCode = await completion(ctx);

      expect(exitCode).toBe(0);
      // Should return no output (git fallback handled shell-side)
      expect(buffer.stdout).toBe('');

      delete process.env.GDX_CMP_IDX;
   });

   it('suggests fork aliases for parallel switch and join', async () => {
      buffer.stdout = '';
      const worktreeRoot = path.join(tmpRootDir, 'tmp', 'worktrees', 'project', 'master');
      const forkOne = path.join(worktreeRoot, 'feature-one');
      const forkTwo = path.join(worktreeRoot, 'feature-two');
      fs.mkdirSync(forkOne, { recursive: true });
      fs.mkdirSync(forkTwo, { recursive: true });

      const createdAt = new Date().toISOString();
      const metaOne = {
         alias: 'feature-one',
         branch: 'master',
         safeBranch: 'master',
         project: 'project',
         safeProject: 'project',
         originPath: tmpDir,
         baseCommit: 'deadbeef',
         createdAt,
      };
      const metaTwo = {
         alias: 'feature-two',
         branch: 'master',
         safeBranch: 'master',
         project: 'project',
         safeProject: 'project',
         originPath: tmpDir,
         baseCommit: 'deadbeef',
         createdAt,
      };
      fs.writeFileSync(path.join(forkOne, '.git-parallel.json'), JSON.stringify(metaOne));
      fs.writeFileSync(path.join(forkTwo, '.git-parallel.json'), JSON.stringify(metaTwo));

      buffer.stdout = '';
      process.env.GDX_CMP_IDX = '2';
      const switchCtx = createGdxContext(tmpDir, ['__completion', 'parallel', 'switch', '']);
      const switchExit = await completion(switchCtx);
      expect(switchExit).toBe(0);
      expect(buffer.stdout).toContain('origin');
      expect(buffer.stdout).toContain('feature-one');
      expect(buffer.stdout).toContain('feature-two');

      buffer.stdout = '';
      process.env.GDX_CMP_IDX = '3';
      const joinCtx = createGdxContext(tmpDir, ['__completion', 'parallel', 'join', '--keep', '']);
      const joinExit = await completion(joinCtx);
      expect(joinExit).toBe(0);
      expect(buffer.stdout).toContain('feature-one');
      expect(buffer.stdout).toContain('feature-two');
      expect(buffer.stdout).not.toContain('origin');

      buffer.stdout = '';
      process.env.GDX_CMP_IDX = '2';
      const joinFlagCtx = createGdxContext(tmpDir, ['__completion', 'parallel', 'join', '-']);
      const joinFlagExit = await completion(joinFlagCtx);
      expect(joinFlagExit).toBe(0);
      expect(buffer.stdout).toContain('--recursive');

      delete process.env.GDX_CMP_IDX;
   });

   it('does not suggest flags before alias for parallel open', async () => {
      buffer.stdout = '';
      const worktreeRoot = path.join(tmpRootDir, 'tmp', 'worktrees', 'project', 'master');
      const fork = path.join(worktreeRoot, 'flag-test');
      fs.mkdirSync(fork, { recursive: true });

      const meta = {
         alias: 'flag-test',
         branch: 'master',
         safeBranch: 'master',
         project: 'project',
         safeProject: 'project',
         originPath: tmpDir,
         baseCommit: 'deadbeef',
         createdAt: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(fork, '.git-parallel.json'), JSON.stringify(meta));

      buffer.stdout = '';
      process.env.GDX_CMP_IDX = '2';
      const openFlagCtx = createGdxContext(tmpDir, ['__completion', 'parallel', 'open', '-']);
      const openFlagExit = await completion(openFlagCtx);
      expect(openFlagExit).toBe(0);
      expect(buffer.stdout).not.toContain('--copy');
      expect(buffer.stdout).not.toContain('flag-test');

      buffer.stdout = '';
      process.env.GDX_CMP_IDX = '3';
      const openAliasFlagCtx = createGdxContext(tmpDir, [
         '__completion',
         'parallel',
         'open',
         'origin',
         '-',
      ]);
      const openAliasFlagExit = await completion(openAliasFlagCtx);
      expect(openAliasFlagExit).toBe(0);
      expect(buffer.stdout).toContain('--copy');

      delete process.env.GDX_CMP_IDX;
   });
});
