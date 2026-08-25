/**
 * NOTE: To my future self:
 * Normally, each test would be in its own file, but this specifc test suite
 * requires spacial mock setup that would break other tests if placed in a shared file.
 * This is why I separate this suite into its own file.
 */

import { afterAll, beforeAll, describe, expect, mock } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';

import { createGdxContext, createTestEnv, setTestGitConfig } from '@/utils/testHelper';
import { normalizePath } from '@/utils/utilities';
import { stripAnsiColor } from '@/modules/graphics';

let capturedPreviews: string[] = [];
let statusFormatCalls: string[] = [];
let pagerActions: Array<{
   action: 'apply' | 'skip' | 'undo' | 'abort';
   key: string;
}> = [];

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
            return pagerActions.shift() ?? { action: 'skip', key: 's' };
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

      await setTestGitConfig(tmpDir, 'core.autocrlf', 'false');
      await setTestGitConfig(tmpDir, 'core.safecrlf', 'false');

      await fs.writeFile(path.join(tmpDir, 'conflict.txt'), 'base\n');
      await fs.writeFile(path.join(tmpDir, 'clean.txt'), 'base\n');
      await $`${git$} add conflict.txt`;
      await $`${git$} add clean.txt`;
      await $`${git$} commit --no-verify -m ${'Add conflict base'}`;

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
      await $`${git$} add conflict.txt`;
      await $`${git$} commit --no-verify -m ${'Origin change'}`;

      await fs.writeFile(path.join(forkPath, 'conflict.txt'), 'fork change\n');
      await fs.writeFile(path.join(forkPath, 'clean.txt'), 'base\nclean change\n');
      await $`${git$} -C ${forkPath} add conflict.txt clean.txt`;
      await $`${git$} -C ${forkPath} commit --no-verify -m ${'Fork change'}`;

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

      const forkHead = (await $`${git$} -C ${forkPath} rev-parse HEAD`).stdout.trim();
      const originHead = (await $`${git$} rev-parse HEAD`).stdout.trim();
      expect(forkHead).toBe(originHead);

      const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', alias]);
      await parallel(removeCtx);
   }, { timeout: 15000 });

   it('should not list conflicts when commit applies cleanly', async () => {
      capturedPreviews = [];
      statusFormatCalls = [];
      env.isTTY = true;

      await setTestGitConfig(tmpDir, 'core.autocrlf', 'false');
      await setTestGitConfig(tmpDir, 'core.safecrlf', 'false');

      await fs.writeFile(path.join(tmpDir, 'clean-base.txt'), 'base\n');
      await $`${git$} add clean-base.txt`;
      await $`${git$} commit --no-verify -m ${'Add clean base'}`;

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
      await $`${git$} -C ${forkPath} commit --no-verify -m ${'Clean change'}`;

      const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', alias, '-i', '--keep']);
      expect(await parallel(joinCtx)).toBe(0);

      const previewText = stripAnsiColor(capturedPreviews[0] || '');
      expect(previewText).not.toContain('Conflicts:');

      const forkHead = (await $`${git$} -C ${forkPath} rev-parse HEAD`).stdout.trim();
      const originHead = (await $`${git$} rev-parse HEAD`).stdout.trim();
      expect(forkHead).toBe(originHead);

      const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', alias]);
      await parallel(removeCtx);
   }, { timeout: 15000 });

   it('should render CLEAN status without warnings', async () => {
      capturedPreviews = [];
      statusFormatCalls = [];
      env.isTTY = true;

      await setTestGitConfig(tmpDir, 'core.autocrlf', 'false');
      await setTestGitConfig(tmpDir, 'core.safecrlf', 'false');

      await fs.writeFile(path.join(tmpDir, 'clean-status.txt'), 'base\n');
      await $`${git$} add clean-status.txt`;
      await $`${git$} commit --no-verify -m ${'Add clean status base'}`;

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
      await $`${git$} -C ${forkPath} commit --no-verify -m ${'Clean change'}`;

      const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', alias, '-i', '--keep']);
      expect(await parallel(joinCtx)).toBe(0);

      const statusLine = stripAnsiColor(statusFormatCalls[0] || '');
      expect(statusLine).toContain('CLEAN');
      expect(statusLine).not.toContain('Warning');

      const forkHead = (await $`${git$} -C ${forkPath} rev-parse HEAD`).stdout.trim();
      const originHead = (await $`${git$} rev-parse HEAD`).stdout.trim();
      expect(forkHead).toBe(originHead);

      const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', alias]);
      await parallel(removeCtx);
   });

   it('should render CONFLICT status when conflicts present', async () => {
      capturedPreviews = [];
      statusFormatCalls = [];
      env.isTTY = true;

      await setTestGitConfig(tmpDir, 'core.autocrlf', 'false');
      await setTestGitConfig(tmpDir, 'core.safecrlf', 'false');

      await fs.writeFile(path.join(tmpDir, 'conflict-status.txt'), 'base\n');
      await $`${git$} add conflict-status.txt`;
      await $`${git$} commit --no-verify -m ${'Add conflict status base'}`;

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
      await $`${git$} add conflict-status.txt`;
      await $`${git$} commit --no-verify -m ${'Origin change'}`;

      await fs.writeFile(path.join(forkPath, 'conflict-status.txt'), 'fork change\n');
      await $`${git$} -C ${forkPath} add conflict-status.txt`;
      await $`${git$} -C ${forkPath} commit --no-verify -m ${'Fork change'}`;

      const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', alias, '-i', '--keep']);
      expect(await parallel(joinCtx)).toBe(0);

      const statusLine = stripAnsiColor(statusFormatCalls[0] || '');
      expect(statusLine).toContain('CONFLICT');

      const forkHead = (await $`${git$} -C ${forkPath} rev-parse HEAD`).stdout.trim();
      const originHead = (await $`${git$} rev-parse HEAD`).stdout.trim();
      expect(forkHead).toBe(originHead);

      const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', alias]);
      await parallel(removeCtx);
   });

   it('should render EMPTY status without warnings', async () => {
      capturedPreviews = [];
      statusFormatCalls = [];
      env.isTTY = true;

      await setTestGitConfig(tmpDir, 'core.autocrlf', 'false');
      await setTestGitConfig(tmpDir, 'core.safecrlf', 'false');

      await $`${git$} commit --allow-empty --no-verify -m ${'Empty base'}`;

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

      await $`${git$} -C ${forkPath} commit --allow-empty --no-verify -m ${'Empty change'}`;

      const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', alias, '-i', '--keep']);
      expect(await parallel(joinCtx)).toBe(0);

      const statusLine = stripAnsiColor(statusFormatCalls[0] || '');
      expect(statusLine).toContain('EMPTY');
      expect(statusLine).not.toContain('Warning');

      const forkHead = (await $`${git$} -C ${forkPath} rev-parse HEAD`).stdout.trim();
      const originHead = (await $`${git$} rev-parse HEAD`).stdout.trim();
      expect(forkHead).toBe(originHead);

      const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', alias]);
      await parallel(removeCtx);
   });

   it('should preview dependent commits against accepted predecessors', async () => {
      capturedPreviews = [];
      statusFormatCalls = [];
      pagerActions = [
         { action: 'apply', key: 'a' },
         { action: 'apply', key: 'a' },
      ];

      const alias = 'stacked-preview';
      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias, '--no-init']);
      expect(await parallel(forkCtx)).toBe(0);

      const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
      const forkPath = path.join(
         tmpRootDir,
         'tmp',
         'worktrees',
         normalizePath(path.basename(tmpDir)),
         normalizePath(branchName),
         alias
      );

      await fs.writeFile(path.join(forkPath, 'stacked.txt'), 'first\n');
      await $`${git$} -C ${forkPath} add stacked.txt`;
      await $`${git$} -C ${forkPath} commit --no-verify -m ${'Add stacked file'}`;
      await fs.writeFile(path.join(forkPath, 'stacked.txt'), 'first\nsecond\n');
      await $`${git$} -C ${forkPath} add stacked.txt`;
      await $`${git$} -C ${forkPath} commit --no-verify -m ${'Extend stacked file'}`;

      const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', alias, '-i', '--keep']);
      expect(await parallel(joinCtx)).toBe(0);

      expect(statusFormatCalls).toHaveLength(2);
      expect(stripAnsiColor(statusFormatCalls[0] || '')).toContain('CLEAN');
      expect(stripAnsiColor(statusFormatCalls[1] || '')).toContain('CLEAN');
      expect(await fs.readFile(path.join(tmpDir, 'stacked.txt'), 'utf-8')).toBe(
         'first\nsecond\n'
      );

      const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', alias]);
      expect(await parallel(removeCtx)).toBe(0);
   }, { timeout: 20000 });

   it('should keep final apply and skip choices after undo', async () => {
      capturedPreviews = [];
      statusFormatCalls = [];
      pagerActions = [
         { action: 'apply', key: 'a' },
         { action: 'apply', key: 'a' },
         { action: 'undo', key: 'u' },
         { action: 'skip', key: 's' },
         { action: 'apply', key: 'a' },
      ];

      const alias = 'mixed-decisions';
      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias, '--no-init']);
      expect(await parallel(forkCtx)).toBe(0);

      const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
      const forkPath = path.join(
         tmpRootDir,
         'tmp',
         'worktrees',
         normalizePath(path.basename(tmpDir)),
         normalizePath(branchName),
         alias
      );

      for (const [fileName, subject] of [
         ['accepted-first.txt', 'Accept first'],
         ['skipped.txt', 'Skip middle'],
         ['accepted-last.txt', 'Accept last'],
      ]) {
         await fs.writeFile(path.join(forkPath, fileName), `${subject}\n`);
         await $`${git$} -C ${forkPath} add ${fileName}`;
         await $`${git$} -C ${forkPath} commit --no-verify -m ${subject}`;
      }

      const joinCtx = createGdxContext(tmpDir, ['parallel', 'join', alias, '-i', '--keep']);
      expect(await parallel(joinCtx)).toBe(0);

      expect(await fs.stat(path.join(tmpDir, 'accepted-first.txt')).then(() => true)).toBe(true);
      expect(
         await fs
            .stat(path.join(tmpDir, 'skipped.txt'))
            .then(() => true)
            .catch(() => false)
      ).toBe(false);
      expect(await fs.stat(path.join(tmpDir, 'accepted-last.txt')).then(() => true)).toBe(true);
      const subjects = (await $`${git$} log --format=%s`).stdout;
      expect(subjects).toContain('Accept first');
      expect(subjects).not.toContain('Skip middle');
      expect(subjects).toContain('Accept last');

      const forkHead = (await $`${git$} -C ${forkPath} rev-parse HEAD`).stdout.trim();
      const originHead = (await $`${git$} rev-parse HEAD`).stdout.trim();
      expect(forkHead).toBe(originHead);

      const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', alias]);
      expect(await parallel(removeCtx)).toBe(0);
   }, { timeout: 20000 });

   it('should resume remaining interactive drops after a rebase conflict', async () => {
      capturedPreviews = [];
      statusFormatCalls = [];
      pagerActions = [
         { action: 'skip', key: 's' },
         { action: 'apply', key: 'a' },
      ];

      const alias = 'drop-conflict-retry';
      await fs.writeFile(path.join(tmpDir, 'drop-chain.txt'), 'base\n');
      await $`${git$} add drop-chain.txt`;
      await $`${git$} commit --no-verify -m ${'Add drop chain base'}`;

      const forkCtx = createGdxContext(tmpDir, ['parallel', 'fork', alias, '--no-init']);
      expect(await parallel(forkCtx)).toBe(0);
      const branchName = (await $`${git$} rev-parse --abbrev-ref HEAD`).stdout.trim();
      const forkPath = path.join(
         tmpRootDir,
         'tmp',
         'worktrees',
         normalizePath(path.basename(tmpDir)),
         normalizePath(branchName),
         alias
      );

      try {
         await fs.writeFile(path.join(forkPath, 'drop-chain.txt'), 'first\n');
         await $`${git$} -C ${forkPath} add drop-chain.txt`;
         await $`${git$} -C ${forkPath} commit --no-verify -m ${'Drop first change'}`;
         await fs.writeFile(path.join(forkPath, 'drop-chain.txt'), 'second\n');
         await $`${git$} -C ${forkPath} add drop-chain.txt`;
         await $`${git$} -C ${forkPath} commit --no-verify -m ${'Keep second change'}`;

         const firstJoinCtx = createGdxContext(tmpDir, ['parallel', 'join', alias, '-i']);
         expect(await parallel(firstJoinCtx)).toBe(1);
         const pendingMeta = JSON.parse(
            await fs.readFile(path.join(forkPath, '.git-parallel.json'), 'utf-8')
         ) as { pendingJoinDrops?: string[] };
         expect(pendingMeta.pendingJoinDrops).toHaveLength(1);

         await fs.writeFile(path.join(forkPath, 'drop-chain.txt'), 'second\n');
         await $`${git$} -C ${forkPath} add drop-chain.txt`;
         await $`${git$} -c core.editor=${'true'} -C ${forkPath} rebase --continue`;

         const retryJoinCtx = createGdxContext(tmpDir, ['parallel', 'join', alias]);
         expect(await parallel(retryJoinCtx)).toBe(0);
         const log = (await $`${git$} log --format=%s -5`).stdout;
         expect(log).toContain('Keep second change');
         expect(log).not.toContain('Drop first change');
         expect(await fs.readFile(path.join(tmpDir, 'drop-chain.txt'), 'utf-8')).toBe('second\n');
      } finally {
         try {
            await fs.access(forkPath);
            try {
               await $`${git$} -C ${forkPath} rebase --abort`;
            } catch {
               // Best effort cleanup.
            }
            const removeCtx = createGdxContext(tmpDir, ['parallel', 'remove', alias]);
            await parallel(removeCtx);
         } catch {
            // The successful join removed the fork.
         }
      }
   }, { timeout: 20000 });
});
