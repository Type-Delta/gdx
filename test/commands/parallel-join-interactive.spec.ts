/**
 * NOTE: To my future self:
 * Normally, each test would be in its own file, but this specifc test suite
 * requires spacial mock setup that would break other tests if placed in a shared file.
 * This is why I separate this suite into its own file.
 */

import { afterAll, beforeAll, describe, expect, mock } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';

import { createGdxContext, createTestEnv } from '@/utils/testHelper';
import { normalizePath } from '@/utils/utilities';
import { stripAnsiColor } from '@/modules/graphics';

let capturedPreviews: string[] = [];
let statusFormatCalls: string[] = [];

let parallel: typeof import('@/commands/parallel').default;
let actualPager: typeof import('@/modules/pager');

describe('gdx parallel join conflict preview', async () => {
   const { tmpDir, tmpRootDir, $, it, env } = await createTestEnv({
      autoResetBuffer: true,
      suitName: 'parallel-join-interactive'
   });
   const { git$ } = createGdxContext(tmpDir);
   beforeAll(async () => {
      actualPager = await import('../../src/modules/pager');

      mock.module('@/modules/pager', () => ({
         ...actualPager,
         // eslint-disable-next-line @typescript-eslint/no-explicit-any
         pager: async (content: string, options: any) => {
            if (content) capturedPreviews.push(content);
            if (typeof options?.statusText === 'string') {
               statusFormatCalls.push(options.statusText);
            }
            return { action: 'skip', key: 's' };
         },
      }));

      mock.module('@shikijs/cli', () => ({
         codeToANSI: async (code: string) => code,
      }));

      ({ default: parallel } = await import('@/commands/parallel'));
   });

   afterAll(() => {
      mock.restore();
   });

   env.isTTY = true;

   it('should include only conflicting files in preview', async () => {
      capturedPreviews = [];
      statusFormatCalls = [];
      env.isTTY = true;

      await $`${git$} config core.autocrlf false`;
      await $`${git$} config core.safecrlf false`;

      await fs.writeFile(path.join(tmpDir, 'conflict.txt'), 'base\n');
      await fs.writeFile(path.join(tmpDir, 'clean.txt'), 'base\n');
      await $`${git$} add conflict.txt`;
      await $`${git$} add clean.txt`;
      await $`${git$} commit -m ${'Add conflict base'}`;

      const alias = 'conflict-preview';
      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias]);
      expect(await parallel(forkCtx)).toBe(0);

      const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
      const projectName = path.basename(tmpDir);
      const worktreeRoot = path.join(
         tmpRootDir,
         'tmp',
         'worktrees',
         normalizePath(projectName),
         normalizePath(branchName)
      );
      const forkPath = path.join(worktreeRoot, alias);

      await fs.writeFile(path.join(tmpDir, 'conflict.txt'), 'origin change\n');
      await $`${git$} -C ${tmpDir} add conflict.txt`;
      await $`${git$} -C ${tmpDir} commit -m ${'Origin change'}`;

      await fs.writeFile(path.join(forkPath, 'conflict.txt'), 'fork change\n');
      await fs.writeFile(path.join(forkPath, 'clean.txt'), 'base\nclean change\n');
      await $`${git$} -C ${forkPath} add conflict.txt clean.txt`;
      await $`${git$} -C ${forkPath} commit -m ${'Fork change'}`;

      const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', alias, '-i', '--keep']);
      expect(await parallel(joinCtx)).toBe(0);

      const previewText = stripAnsiColor(capturedPreviews[0] || '');
      const conflictIndex = previewText.indexOf('Conflicts:');
      if (conflictIndex !== -1) {
         expect(previewText).toContain('conflict.txt');
         const conflictSummary = previewText.slice(conflictIndex);
         if (conflictSummary.includes('|')) {
            expect(conflictSummary).toMatch(/conflict\.txt\s*\|\s*\d+\s+conflict/);
         }
      } else {
         expect(previewText).not.toContain('Conflicts:');
      }

      const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', alias]);
      await parallel(removeCtx);
   });

   it('should not list conflicts when commit applies cleanly', async () => {
      capturedPreviews = [];
      statusFormatCalls = [];
      env.isTTY = true;

      await $`${git$} config core.autocrlf false`;
      await $`${git$} config core.safecrlf false`;

      await fs.writeFile(path.join(tmpDir, 'clean-base.txt'), 'base\n');
      await $`${git$} add clean-base.txt`;
      await $`${git$} commit -m ${'Add clean base'}`;

      const alias = 'clean-preview';
      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias]);
      expect(await parallel(forkCtx)).toBe(0);

      const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
      const projectName = path.basename(tmpDir);
      const worktreeRoot = path.join(
         tmpRootDir,
         'tmp',
         'worktrees',
         normalizePath(projectName),
         normalizePath(branchName)
      );
      const forkPath = path.join(worktreeRoot, alias);

      await fs.writeFile(path.join(forkPath, 'clean-base.txt'), 'base\nclean change\n');
      await $`${git$} -C ${forkPath} add clean-base.txt`;
      await $`${git$} -C ${forkPath} commit -m ${'Clean change'}`;

      const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', alias, '-i', '--keep']);
      expect(await parallel(joinCtx)).toBe(0);

      const previewText = stripAnsiColor(capturedPreviews[0] || '');
      expect(previewText).not.toContain('Conflicts:');

      const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', alias]);
      await parallel(removeCtx);
   });

   it('should render CLEAN status without warnings', async () => {
      capturedPreviews = [];
      statusFormatCalls = [];
      env.isTTY = true;

      await $`${git$} config core.autocrlf false`;
      await $`${git$} config core.safecrlf false`;

      await fs.writeFile(path.join(tmpDir, 'clean-status.txt'), 'base\n');
      await $`${git$} add clean-status.txt`;
      await $`${git$} commit -m ${'Add clean status base'}`;

      const alias = 'clean-status';
      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias]);
      expect(await parallel(forkCtx)).toBe(0);

      const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
      const projectName = path.basename(tmpDir);
      const worktreeRoot = path.join(
         tmpRootDir,
         'tmp',
         'worktrees',
         normalizePath(projectName),
         normalizePath(branchName)
      );
      const forkPath = path.join(worktreeRoot, alias);

      await fs.writeFile(path.join(forkPath, 'clean-status.txt'), 'base\nclean change\n');
      await $`${git$} -C ${forkPath} add clean-status.txt`;
      await $`${git$} -C ${forkPath} commit -m ${'Clean change'}`;

      const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', alias, '-i', '--keep']);
      expect(await parallel(joinCtx)).toBe(0);

      const statusLine = stripAnsiColor(statusFormatCalls[0] || '');
      expect(statusLine).toContain('CLEAN');
      expect(statusLine).not.toContain('Warning');

      const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', alias]);
      await parallel(removeCtx);
   });

   it('should render CONFLICT status when conflicts present', async () => {
      capturedPreviews = [];
      statusFormatCalls = [];
      env.isTTY = true;

      await $`${git$} config core.autocrlf false`;
      await $`${git$} config core.safecrlf false`;

      await fs.writeFile(path.join(tmpDir, 'conflict-status.txt'), 'base\n');
      await $`${git$} add conflict-status.txt`;
      await $`${git$} commit -m ${'Add conflict status base'}`;

      const alias = 'conflict-status';
      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias]);
      expect(await parallel(forkCtx)).toBe(0);

      const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
      const projectName = path.basename(tmpDir);
      const worktreeRoot = path.join(
         tmpRootDir,
         'tmp',
         'worktrees',
         normalizePath(projectName),
         normalizePath(branchName)
      );
      const forkPath = path.join(worktreeRoot, alias);

      await fs.writeFile(path.join(tmpDir, 'conflict-status.txt'), 'origin change\n');
      await $`${git$} -C ${tmpDir} add conflict-status.txt`;
      await $`${git$} -C ${tmpDir} commit -m ${'Origin change'}`;

      await fs.writeFile(path.join(forkPath, 'conflict-status.txt'), 'fork change\n');
      await $`${git$} -C ${forkPath} add conflict-status.txt`;
      await $`${git$} -C ${forkPath} commit -m ${'Fork change'}`;

      const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', alias, '-i', '--keep']);
      expect(await parallel(joinCtx)).toBe(0);

      const statusLine = stripAnsiColor(statusFormatCalls[0] || '');
      expect(statusLine).toContain('CONFLICT');

      const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', alias]);
      await parallel(removeCtx);
   });

   it('should render EMPTY status without warnings', async () => {
      capturedPreviews = [];
      statusFormatCalls = [];
      env.isTTY = true;

      await $`${git$} config core.autocrlf false`;
      await $`${git$} config core.safecrlf false`;

      await $`${git$} commit --allow-empty -m ${'Empty base'}`;

      const alias = 'empty-status';
      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias]);
      expect(await parallel(forkCtx)).toBe(0);

      const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
      const projectName = path.basename(tmpDir);
      const worktreeRoot = path.join(
         tmpRootDir,
         'tmp',
         'worktrees',
         normalizePath(projectName),
         normalizePath(branchName)
      );
      const forkPath = path.join(worktreeRoot, alias);

      await $`${git$} -C ${forkPath} commit --allow-empty -m ${'Empty change'}`;

      const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', alias, '-i', '--keep']);
      expect(await parallel(joinCtx)).toBe(0);

      const statusLine = stripAnsiColor(statusFormatCalls[0] || '');
      expect(statusLine).toContain('EMPTY');
      expect(statusLine).not.toContain('Warning');

      const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', alias]);
      await parallel(removeCtx);
   });
});
